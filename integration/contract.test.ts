/**
 * Contract snapshot check (stage-6 brief, deliverable 4): every route the
 * pinned `@opencode/client` can call must exist on the OpenAPI document
 * of the server the harness runs — by default the published
 * `@opencode/cli` binary (`opencode2`) at the same build as the pinned
 * client — and the response contracts the provider depends on must have the
 * expected shape. Drift is reported in the failure output
 * (and logged when server-only operations appear — those are findings, not
 * failures).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { integrationContext, suiteTitle } from "./harness/context.js";

const ctx = integrationContext();

interface ClientRoute {
  method: string;
  path: string;
}

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]);

/**
 * Extract `{method, path}` descriptors from the pinned client's generated
 * source. Path templates normalize to OpenAPI placeholder style:
 * `${encodeURIComponent(input.sessionID)}` → `{sessionID}`.
 */
function pinnedClientRoutes(): ClientRoute[] {
  // The generated client is bundled: `client.js` re-exports `make` from
  // hashed chunks, so follow its relative imports to collect the descriptors.
  const visited = new Set<string>();
  let source = "";
  const collect = (file: string): void => {
    if (visited.has(file)) {
      return;
    }
    visited.add(file);
    const text = readFileSync(file, "utf8");
    source += text;
    for (const match of text.matchAll(
      /(?:from|import)\s*"(\.{1,2}\/[^"]+)"/g,
    )) {
      collect(resolve(dirname(file), match[1]!));
    }
  };
  collect(
    join(
      process.cwd(),
      "node_modules/@opencode/client/dist/promise/generated/client.js",
    ),
  );
  const routes: ClientRoute[] = [];
  const descriptor = /method: "(\w+)",\s*path: [`"]([^`"]+)[`"]/g;
  for (const match of source.matchAll(descriptor)) {
    const path = match[2]!
      .replaceAll(/\$\{encodeURIComponent\(input\.(\w+)\)\}/g, "{$1}")
      .replaceAll(/\$\{encodePath\(input\.(\w+)\)\}/g, "{$1}");
    routes.push({ method: match[1]!.toLowerCase(), path });
  }
  return routes;
}

const isTemplateSegment = (segment: string): boolean =>
  /^\{.+\}$/.test(segment);

/**
 * Structural match between a client path template and a server spec path:
 * exact equality, segment-wise equality with template segments allowed to
 * differ only in parameter name, or a server trailing wildcard
 * (`/api/fs/read/*` ↔ client `/api/fs/read/{path}`). A shared prefix alone
 * is NOT a match — `/api/session/{sessionID}/foo` must not be satisfied by
 * an unrelated `/api/session/...` operation.
 */
function pathsMatch(clientPath: string, serverPath: string): boolean {
  if (clientPath === serverPath) {
    return true;
  }
  if (serverPath.endsWith("/*")) {
    const prefix = serverPath.slice(0, -1);
    return clientPath.startsWith(prefix) && clientPath.length > prefix.length;
  }
  const clientSegments = clientPath.split("/");
  const serverSegments = serverPath.split("/");
  if (clientSegments.length !== serverSegments.length) {
    return false;
  }
  return clientSegments.every(
    (segment, index) =>
      segment === serverSegments[index] ||
      (isTemplateSegment(segment) && isTemplateSegment(serverSegments[index]!)),
  );
}

interface OpenApiSpec {
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
}

interface SchemaObject {
  $ref?: string;
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  contentMediaType?: string;
}

/** Resolve a `#/components/schemas/...` reference one level deep. */
function deref(spec: OpenApiSpec, schema: SchemaObject): SchemaObject {
  if (schema.$ref === undefined) {
    return schema;
  }
  const name = schema.$ref.replace("#/components/schemas/", "");
  const resolved = spec.components?.schemas?.[name];
  expect(resolved, `unresolvable schema ref ${schema.$ref}`).toBeDefined();
  return resolved as SchemaObject;
}

/** The `application/json` schema of an operation's declared response. */
function responseSchema(
  spec: OpenApiSpec,
  path: string,
  method: string,
  status: string,
): SchemaObject {
  const operation = spec.paths[path]?.[method] as
    | {
        responses?: Record<
          string,
          { content?: Record<string, { schema?: SchemaObject }> }
        >;
      }
    | undefined;
  expect(operation, `missing operation ${method} ${path}`).toBeDefined();
  const schema =
    operation!.responses?.[status]?.content?.["application/json"]?.schema;
  expect(
    schema,
    `missing ${status} application/json schema on ${method} ${path}`,
  ).toBeDefined();
  return schema!;
}

describe.skipIf(!ctx.available)(suiteTitle("contract snapshot", ctx), () => {
  async function fetchSpec(): Promise<OpenApiSpec> {
    const response = await fetch(`${ctx.baseUrl}/openapi.json`, {
      headers: { Authorization: ctx.authHeader },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as OpenApiSpec;
  }

  it("serves every route the pinned client speaks", async () => {
    const spec = await fetchSpec();
    const routes = pinnedClientRoutes();
    // The pinned client generation carries exactly 139 method+path pairs;
    // a change here means the extraction regex (or chunk walk) drifted.
    expect(routes.length).toBe(139);

    const specPaths = Object.keys(spec.paths);
    const missing = routes.filter(
      ({ method, path }) =>
        !specPaths.some(
          (candidate) =>
            spec.paths[candidate]?.[method] !== undefined &&
            pathsMatch(path, candidate),
        ),
    );
    expect(missing, `client routes missing on the server`).toEqual([]);

    // Server-only drift, per operation (method + path) so new methods on
    // known paths surface too. Findings, not failures.
    const serverOnly: string[] = [];
    for (const [path, entry] of Object.entries(spec.paths)) {
      for (const method of Object.keys(entry)) {
        if (!HTTP_METHODS.has(method)) {
          continue;
        }
        const spoken = routes.some(
          (route) => route.method === method && pathsMatch(route.path, path),
        );
        if (!spoken) {
          serverOnly.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    if (serverOnly.length > 0) {
      console.log(
        `[contract] server-only operations (drift findings, not failures):\n` +
          serverOnly.map((operation) => `  ${operation}`).join("\n"),
      );
    }
  });

  it("keeps the response contracts the provider depends on", async () => {
    const spec = await fetchSpec();

    // interrupt must return {interrupted} (dev CLI served 204/no-body) —
    // asserted on the operation's own 200 schema, not the whole document.
    const interrupted = deref(
      spec,
      responseSchema(spec, "/api/session/{sessionID}/interrupt", "post", "200"),
    );
    expect(interrupted.properties).toHaveProperty("interrupted");
    expect(interrupted.required).toContain("interrupted");

    // prompt receipt is the inbox-item shape the provider correlates on:
    // {data: InboxUser} with the delivery + id fields the reducer keys off.
    const promptEnvelope = deref(
      spec,
      responseSchema(spec, "/api/session/{sessionID}/prompt", "post", "200"),
    );
    const receipt = deref(
      spec,
      (promptEnvelope.properties?.["data"] ?? {}) as SchemaObject,
    );
    expect(receipt.properties).toHaveProperty("delivery");
    expect(receipt.properties).toHaveProperty("id");
    expect(receipt.properties).toHaveProperty("sessionID");

    // Drift finding (recorded, not fixable client-side): the event stream's
    // payload union is NOT described in the OpenAPI document — `data` is an
    // opaque `V2EventEncoded` JSON string, so event-name compatibility
    // cannot be asserted from the spec (the gated suite witnesses the names
    // live instead). Pin the opaque shape so a future inlined union trips
    // this test and invites a stronger check.
    // /api/event declares text/event-stream, not JSON — navigate directly.
    const eventSchema = (
      spec.paths["/api/event"] as {
        get: {
          responses: Record<
            string,
            {
              content: Record<
                string,
                { schema: { properties?: Record<string, unknown> } }
              >;
            }
          >;
        };
      }
    ).get.responses["200"]!.content["text/event-stream"]!.schema;
    expect(eventSchema.properties?.["data"]).toEqual({
      $ref: "#/components/schemas/V2EventEncoded",
    });
    expect(
      deref(spec, { $ref: "#/components/schemas/V2EventEncoded" }),
    ).toEqual({ type: "string", contentMediaType: "application/json" });
  });
});

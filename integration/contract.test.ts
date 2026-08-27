/**
 * Contract snapshot check (stage-6 brief, deliverable 4): every route the
 * pinned `@opencode-ai/client` can call must exist on the source-built
 * server's OpenAPI document, and the response contracts the provider depends
 * on must have the expected shape. Drift is reported in the failure output
 * (and logged when server-only routes appear — those are findings, not
 * failures).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { integrationContext, suiteTitle } from "./harness/context.js";

const ctx = integrationContext();

interface ClientRoute {
  method: string;
  path: string;
}

/**
 * Extract `{method, path}` descriptors from the pinned client's generated
 * source. Path templates normalize to OpenAPI placeholder style:
 * `${encodeURIComponent(input.sessionID)}` → `{sessionID}`.
 */
function pinnedClientRoutes(): ClientRoute[] {
  const source = readFileSync(
    join(
      process.cwd(),
      "node_modules/@opencode-ai/client/dist/promise/generated/client.js",
    ),
    "utf8",
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

describe.skipIf(!ctx.available)(suiteTitle("contract snapshot", ctx), () => {
  async function fetchSpec(): Promise<{
    paths: Record<string, Record<string, unknown>>;
    components?: { schemas?: Record<string, unknown> };
  }> {
    const response = await fetch(`${ctx.baseUrl}/openapi.json`, {
      headers: { Authorization: ctx.authHeader },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
  }

  it("serves every route the pinned client speaks", async () => {
    const spec = await fetchSpec();
    const routes = pinnedClientRoutes();
    expect(routes.length).toBeGreaterThan(100);

    // `/api/fs/read/{path}` uses a wildcard path segment server-side; match
    // by prefix for templates the exact key misses.
    const specPaths = Object.keys(spec.paths);
    const missing = routes.filter(({ method, path }) => {
      const entry = spec.paths[path];
      if (entry !== undefined) {
        return entry[method] === undefined;
      }
      const prefix = path.slice(0, path.indexOf("{"));
      return !specPaths.some(
        (candidate) =>
          prefix.length > 0 &&
          candidate.startsWith(prefix) &&
          spec.paths[candidate]?.[method] !== undefined,
      );
    });
    expect(missing, `client routes missing on the server`).toEqual([]);

    const clientKeys = new Set(routes.map((route) => route.path));
    const serverOnly = specPaths.filter((path) => !clientKeys.has(path));
    if (serverOnly.length > 0) {
      console.log(
        `[contract] server-only routes (drift findings, not failures):\n` +
          serverOnly.map((path) => `  ${path}`).join("\n"),
      );
    }
  });

  it("keeps the response contracts the provider depends on", async () => {
    const spec = await fetchSpec();
    const json = JSON.stringify(spec);

    // interrupt must return {interrupted} (dev CLI served 204/no-body).
    const interrupt = spec.paths["/api/session/{sessionID}/interrupt"] as
      | { post?: unknown }
      | undefined;
    expect(interrupt?.post).toBeDefined();
    expect(json).toContain('"interrupted"');

    // prompt receipt is the inbox-item shape the provider correlates on.
    const prompt = spec.paths["/api/session/{sessionID}/prompt"] as
      | { post?: unknown }
      | undefined;
    expect(prompt?.post).toBeDefined();
    expect(json).toContain('"delivery"');

    // Drift finding (recorded, not fixable client-side): the event stream's
    // payload union is NOT described in the OpenAPI document — `data` is an
    // opaque `V2EventEncoded` JSON string, so event-name compatibility
    // cannot be asserted from the spec (the gated suite witnesses the names
    // live instead). Pin the opaque shape so a future inlined union trips
    // this test and invites a stronger check.
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
      (spec as { components?: { schemas?: Record<string, unknown> } })
        .components?.schemas?.["V2EventEncoded"],
    ).toEqual({ type: "string", contentMediaType: "application/json" });
  });
});

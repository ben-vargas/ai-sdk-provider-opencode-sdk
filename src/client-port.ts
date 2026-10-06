/**
 * Internal client-port facade for the OpenCode v2 client.
 *
 * This is the single seam between the provider and `@opencode/client`:
 * every route/type the provider touches is named here, so churn in the
 * generated client surfaces as compile errors in exactly one module. All
 * signatures are derived (via `Pick`) from the generated client type rather
 * than hand-copied, so this port cannot drift silently from the pinned
 * client. Any reconciliation between server contracts belongs behind this
 * port, not in the language model.
 */
import type { OpenCodeClient } from "@opencode/client";

/**
 * Per-request options accepted by every port method.
 * Re-exported from the generated client: `{signal?, headers?}`.
 */
export type OpencodeRequestOptions = NonNullable<
  Parameters<OpenCodeClient["server"]["info"]>[0]
>;

/**
 * The narrow slice of the OpenCode v2 client the provider needs.
 *
 * `OpenCode.make(...)` (and the embedded host, which mirrors its surface)
 * satisfies this structurally — asserted at compile time by
 * {@link asClientPort} and covered in client-port.test.ts.
 */
export interface OpencodeClientPort {
  readonly server: Pick<OpenCodeClient["server"], "info">;
  readonly session: Pick<
    OpenCodeClient["session"],
    | "create"
    | "get"
    | "prompt"
    | "wait"
    | "interrupt"
    | "switchModel"
    | "switchAgent"
    | "message"
    | "context"
    | "log"
  > & {
    /**
     * Cancel a not-yet-delivered inbox item (abort before delivery); list
     * pending items (delivery-uncertainty check after a failed prompt).
     */
    readonly inbox: Pick<OpenCodeClient["session"]["inbox"], "cancel" | "list">;
    /** Session-scoped forms: recovery listing and reply/cancel. */
    readonly form: Pick<
      OpenCodeClient["session"]["form"],
      "list" | "reply" | "cancel"
    >;
    /**
     * Session instruction entries — the real system-prompt channel.
     *
     * An entry renders as `<context key="...">value</context>` into the
     * session's instruction baseline, ahead of the user turn and after the
     * agent's own system prompt, and is re-rendered on every turn (verified
     * live against `opencode2@0.0.0-beta-18286` and exercised against
     * `@opencode/cli@2.0.24` by the integration suite; see
     * spike/artifacts/14b-instruction-entries.json).
     *
     * Optional on the port on purpose: an alternative backend (or a client
     * build predating the route) may not implement it, and the provider
     * feature-detects rather than assuming — falling back to the delimited
     * prepend when the route is absent.
     */
    readonly instructions?: {
      readonly entry: Pick<
        OpenCodeClient["session"]["instructions"]["entry"],
        "put" | "remove" | "list"
      >;
    };
  };
  readonly message: Pick<OpenCodeClient["message"], "list">;
  /** Catalog lookup: resolves a bare model ID + variant to a providerID. */
  readonly model: Pick<OpenCodeClient["model"], "list">;
  /**
   * Session-less, tool-less, history-less text generation (documented
   * upstream as exactly that) — the safe repair channel for the opt-in JSON
   * validate/repair loop.
   */
  readonly generate: Pick<OpenCodeClient["generate"], "text">;
  readonly event: Pick<OpenCodeClient["event"], "subscribe">;
  readonly permission: Pick<
    OpenCodeClient["permission"],
    "list" | "get" | "reply"
  >;
  readonly migration: {
    readonly v1: Pick<OpenCodeClient["migration"]["v1"], "status">;
  };
}

/**
 * Narrow a full OpenCode client to the port the provider uses.
 *
 * The bare return doubles as a compile-time assertion that the generated
 * client still satisfies the port — if a pinned-client bump changes any of the
 * routes above, `npm run typecheck` fails here first.
 */
export function asClientPort(client: OpenCodeClient): OpencodeClientPort {
  return client;
}

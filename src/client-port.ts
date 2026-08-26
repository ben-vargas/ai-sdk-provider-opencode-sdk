/**
 * Internal client-port facade for the OpenCode v2 client.
 *
 * This is the single seam between the provider and `@opencode-ai/client`:
 * every route/type the provider touches is named here, so beta churn in the
 * generated client surfaces as compile errors in exactly one module. All
 * signatures are derived (via `Pick`) from the generated client type rather
 * than hand-copied, so this port cannot drift silently from the pinned beta.
 *
 * The dev-channel CLI currently serves a different wire contract than the
 * beta client types (`session.next.*` events, nested prompt body). Any
 * reconciliation between those contracts belongs behind this port, not in
 * the language model (see docs/v2-spike-findings.md, finding 0).
 */
import type { OpenCodeClient } from "@opencode-ai/client";

/**
 * Per-request options accepted by every port method.
 * Re-exported from the generated client: `{signal?, headers?}`.
 */
export type OpencodeRequestOptions = NonNullable<
  Parameters<OpenCodeClient["health"]["get"]>[0]
>;

/**
 * The narrow slice of the OpenCode v2 client the provider needs.
 *
 * `OpenCode.make(...)` (and the embedded host, which mirrors its surface)
 * satisfies this structurally — asserted at compile time by
 * {@link asClientPort} and covered in client-port.test.ts.
 */
export interface OpencodeClientPort {
  readonly health: Pick<OpenCodeClient["health"], "get">;
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
    /** Cancel a not-yet-delivered inbox item (abort before delivery). */
    readonly inbox: Pick<OpenCodeClient["session"]["inbox"], "cancel">;
  };
  readonly message: Pick<OpenCodeClient["message"], "list">;
  readonly event: Pick<OpenCodeClient["event"], "subscribe">;
  readonly permission: Pick<
    OpenCodeClient["permission"],
    "list" | "get" | "reply"
  >;
  readonly form: Pick<
    OpenCodeClient["form"],
    "list" | "state" | "reply" | "cancel"
  >;
  readonly migration: {
    readonly v1: Pick<OpenCodeClient["migration"]["v1"], "status">;
  };
}

/**
 * Narrow a full OpenCode client to the port the provider uses.
 *
 * The bare return doubles as a compile-time assertion that the generated
 * client still satisfies the port — if a pinned-beta bump changes any of the
 * routes above, `npm run typecheck` fails here first.
 */
export function asClientPort(client: OpenCodeClient): OpencodeClientPort {
  return client;
}

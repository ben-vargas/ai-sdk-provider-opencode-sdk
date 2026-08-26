import type { V2EventFixture } from "./helpers.js";
import { simpleTextTurn } from "./simple-text-turn.js";
import { reasoningTextInterleaved } from "./reasoning-text-interleaved.js";
import { multiStepToolTurn } from "./multi-step-tool-turn.js";
import { toolFailure } from "./tool-failure.js";
import { stepFailedContentFilter } from "./step-failed-content-filter.js";
import {
  permissionBeforeInputAvailable,
  permissionBeforeToolStart,
  permissionSourceless,
} from "./permission-approval.js";
import { formCreatedMidTurn } from "./form-created-mid-turn.js";
import {
  executionInterruptedShutdown,
  executionInterruptedSuperseded,
  executionInterruptedUser,
} from "./execution-interrupted.js";
import { duplicateDurableEvents } from "./duplicate-durable-events.js";
import { deltaAfterMissedStarted } from "./delta-after-missed-started.js";
import { logSyncedReplay } from "./log-synced.js";
import { outOfOrderOrdinals } from "./out-of-order-ordinals.js";

export * from "./helpers.js";

/** All fixtures, for table-driven reducer tests. */
export const fixtures: V2EventFixture[] = [
  simpleTextTurn,
  reasoningTextInterleaved,
  multiStepToolTurn,
  toolFailure,
  stepFailedContentFilter,
  permissionBeforeInputAvailable,
  permissionBeforeToolStart,
  permissionSourceless,
  formCreatedMidTurn,
  executionInterruptedUser,
  executionInterruptedSuperseded,
  executionInterruptedShutdown,
  duplicateDurableEvents,
  deltaAfterMissedStarted,
  logSyncedReplay,
  outOfOrderOrdinals,
];

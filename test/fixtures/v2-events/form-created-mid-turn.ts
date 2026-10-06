import {
  duplicate,
  eventFactory,
  finishPart,
  tokens,
  SESSION_ID,
  type V2EventFixture,
} from "./helpers.js";

const f = eventFactory();
const MSG = "msg_f1";
const BLOCK = `${MSG}:text:0`;
const FORM = f.formCreated("form_1", "Pick a deployment target", [
  {
    key: "target",
    type: "string",
    options: [{ value: "staging", label: "Staging" }],
  },
]);

/**
 * `form.created` mid-turn routes to the `onForm` handler slot (deduplicated
 * by form id) and fabricates NO model content. The session ID for form
 * events lives at `data.form.sessionID`.
 */
export const formCreatedMidTurn: V2EventFixture = {
  name: "form created mid-turn",
  description: "forms route to the handler callback; no stream parts",
  sessionId: SESSION_ID,
  events: [
    f.executionStarted(),
    f.stepStarted(MSG),
    f.textStarted(MSG, 0),
    f.textDelta(MSG, 0, "Deploying..."),
    FORM,
    duplicate(FORM),
    f.textEnded(MSG, 0, "Deploying..."),
    f.stepEnded(MSG, "stop", tokens(15, 4), 0),
    f.executionSucceeded(),
  ],
  expectedForms: ["form_1"],
  expected: [
    { type: "text-start", id: BLOCK },
    { type: "text-delta", id: BLOCK, delta: "Deploying..." },
    { type: "text-end", id: BLOCK },
    finishPart({
      finishReason: { unified: "stop", raw: "stop" },
      usage: { input: 15, output: 4 },
      messageId: MSG,
      outcome: "succeeded",
      finish: "stop",
    }),
  ],
};

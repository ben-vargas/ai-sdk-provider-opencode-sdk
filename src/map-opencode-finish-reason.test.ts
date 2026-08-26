import { describe, expect, it } from "vitest";
import {
  mapInterruptReasonToFinishReason,
  mapOpencodeFinishReason,
  mapStructuredErrorToFinishReason,
  type OpencodeV2Finish,
} from "./map-opencode-finish-reason.js";

describe("mapOpencodeFinishReason", () => {
  const table: Array<[OpencodeV2Finish, string]> = [
    ["stop", "stop"],
    ["length", "length"],
    ["tool-calls", "tool-calls"],
    ["content-filter", "content-filter"],
    ["error", "error"],
    ["unknown", "other"],
  ];

  it.each(table)("maps %s → %s", (finish, unified) => {
    expect(mapOpencodeFinishReason(finish)).toEqual({
      unified,
      raw: finish,
    });
  });

  it("prefers rawFinish for the raw value", () => {
    expect(mapOpencodeFinishReason("stop", "end_turn")).toEqual({
      unified: "stop",
      raw: "end_turn",
    });
  });

  it("maps values outside the closed union to other", () => {
    expect(mapOpencodeFinishReason("something-new")).toEqual({
      unified: "other",
      raw: "something-new",
    });
  });

  it("maps undefined to other with undefined raw", () => {
    expect(mapOpencodeFinishReason(undefined)).toEqual({
      unified: "other",
      raw: undefined,
    });
  });
});

describe("mapStructuredErrorToFinishReason", () => {
  it("normalizes a structured error to error with the native type as raw", () => {
    expect(
      mapStructuredErrorToFinishReason({
        type: "provider_auth",
        message: "bad key",
        status: 401,
      }),
    ).toEqual({ unified: "error", raw: "provider_auth" });
  });
});

describe("mapInterruptReasonToFinishReason", () => {
  it("maps user → stop", () => {
    expect(mapInterruptReasonToFinishReason("user")).toEqual({
      unified: "stop",
      raw: "interrupted:user",
    });
  });

  it("maps superseded → other", () => {
    expect(mapInterruptReasonToFinishReason("superseded")).toEqual({
      unified: "other",
      raw: "interrupted:superseded",
    });
  });

  it("maps shutdown → error", () => {
    expect(mapInterruptReasonToFinishReason("shutdown")).toEqual({
      unified: "error",
      raw: "interrupted:shutdown",
    });
  });
});

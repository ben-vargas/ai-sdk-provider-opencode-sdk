import { describe, expect, it } from "vitest";
import {
  fitsInstructionValue,
  instructionValueBytes,
  INSTRUCTION_KEY_PATTERN,
  INSTRUCTION_VALUE_MAX_BYTES,
  SYSTEM_INSTRUCTION_KEY,
} from "./system-instruction.js";

describe("SYSTEM_INSTRUCTION_KEY", () => {
  it("is namespaced and satisfies the server's key grammar", () => {
    expect(SYSTEM_INSTRUCTION_KEY).toBe("ai-sdk.system");
    expect(INSTRUCTION_KEY_PATTERN.test(SYSTEM_INSTRUCTION_KEY)).toBe(true);
  });
});

describe("INSTRUCTION_KEY_PATTERN", () => {
  // Accept/reject sets are the ones the live server was probed with
  // (spike/artifacts/14b-instruction-entries.json, E6).
  it.each(["a", "ai-sdk.system", "a1._-x", "0", "z9-_."])(
    "accepts %j",
    (key) => {
      expect(INSTRUCTION_KEY_PATTERN.test(key)).toBe(true);
    },
  );

  it.each(["", "AI-SDK", "ai-sdk.System", "_leading", ".dot", "-dash"])(
    "rejects %j",
    (key) => {
      expect(INSTRUCTION_KEY_PATTERN.test(key)).toBe(false);
    },
  );
});

describe("instructionValueBytes", () => {
  it("charges the JSON encoding, quotes included", () => {
    // "hi" -> `"hi"` is 4 bytes.
    expect(instructionValueBytes("hi")).toBe(4);
  });

  it("charges multi-byte characters their UTF-8 length", () => {
    // é is 2 UTF-8 bytes; plus the two quotes.
    expect(instructionValueBytes("é")).toBe(4);
  });

  it("charges escaped characters their escaped length", () => {
    // A newline becomes the two characters \n inside the quotes.
    expect(instructionValueBytes("\n")).toBe(4);
    expect(instructionValueBytes('"')).toBe(4);
  });
});

describe("fitsInstructionValue", () => {
  // The live boundary: 8190 raw ASCII chars encode to exactly 8192 bytes and
  // are accepted; 8191 encode to 8193 and are rejected.
  it("accepts a value whose encoding is exactly the cap", () => {
    const value = "y".repeat(INSTRUCTION_VALUE_MAX_BYTES - 2);
    expect(instructionValueBytes(value)).toBe(INSTRUCTION_VALUE_MAX_BYTES);
    expect(fitsInstructionValue(value)).toBe(true);
  });

  it("rejects a value one byte over the cap", () => {
    const value = "y".repeat(INSTRUCTION_VALUE_MAX_BYTES - 1);
    expect(instructionValueBytes(value)).toBe(INSTRUCTION_VALUE_MAX_BYTES + 1);
    expect(fitsInstructionValue(value)).toBe(false);
  });

  it("accounts for multi-byte characters at the boundary", () => {
    // 4095 x 2-byte chars = 8190 bytes + quotes = exactly the cap.
    const value = "é".repeat(4095);
    expect(instructionValueBytes(value)).toBe(INSTRUCTION_VALUE_MAX_BYTES);
    expect(fitsInstructionValue(value)).toBe(true);
    expect(fitsInstructionValue(value + "é")).toBe(false);
  });

  it("accepts the empty value", () => {
    expect(fitsInstructionValue("")).toBe(true);
  });
});

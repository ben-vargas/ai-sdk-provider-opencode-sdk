import { describe, it, expect } from "vitest";
import { parseDataUrl, planFilePartConversion } from "./opencode-part-utils.js";

describe("opencode-part-utils", () => {
  describe("parseDataUrl", () => {
    it("parses base64 data URLs", () => {
      const parsed = parseDataUrl("data:text/plain;base64,SGVsbG8=");

      expect(parsed).toEqual({
        mediaType: "text/plain",
        data: "SGVsbG8=",
      });
    });

    it("parses data URLs with parameters before base64", () => {
      const parsed = parseDataUrl(
        "data:text/plain;charset=utf-8;base64,SGVsbG8=",
      );

      expect(parsed).toEqual({
        mediaType: "text/plain",
        data: "SGVsbG8=",
      });
    });

    it("returns null for malformed percent-encoding in non-base64 payload", () => {
      const parsed = parseDataUrl("data:text/plain,%ZZ");

      expect(parsed).toBeNull();
    });

    it("parses non-base64 payloads via percent decoding", () => {
      const parsed = parseDataUrl("data:text/plain,Hello%20World");

      expect(parsed).toEqual({
        mediaType: "text/plain",
        data: "SGVsbG8gV29ybGQ=",
      });
    });
  });

  describe("planFilePartConversion", () => {
    it("accepts parameterized base64 data URLs", () => {
      const { plan, error } = planFilePartConversion({
        id: "file-1",
        mime: "text/plain",
        url: "data:text/plain;charset=utf-8;base64,SGVsbG8=",
      });

      expect(error).toBeUndefined();
      expect(plan?.primary).toMatchObject({
        type: "file",
        mediaType: "text/plain",
        data: "SGVsbG8=",
      });
    });

    it("returns invalid-data-url for malformed non-base64 data URLs", () => {
      const { plan, error } = planFilePartConversion({
        id: "file-1",
        mime: "text/plain",
        url: "data:text/plain,%ZZ",
      });

      expect(plan).toBeUndefined();
      expect(error).toBe("invalid-data-url");
    });
  });
});

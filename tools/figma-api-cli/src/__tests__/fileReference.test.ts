import { describe, expect, it } from "vitest";
import { encodeNodeId, normalizeNodeId, parseFileReference } from "../fileReference.js";

describe("parseFileReference", () => {
  it("extracts file key and node id from design URL", () => {
    const input =
      "https://www.figma.com/design/GB2JY7YS9LVIifmcIu83Ju/TLDR--Website?node-id=19-62607&t=abc";
    const result = parseFileReference(input);

    expect(result.fileKey).toBe("GB2JY7YS9LVIifmcIu83Ju");
    expect(result.nodeId).toBe("19:62607");
  });

  it("accepts direct file key", () => {
    const result = parseFileReference("GB2JY7YS9LVIifmcIu83Ju", { defaultNodeId: "12-34" });
    expect(result.fileKey).toBe("GB2JY7YS9LVIifmcIu83Ju");
    expect(result.nodeId).toBe("12:34");
  });

  it("throws on invalid input", () => {
    expect(() => parseFileReference("not-a-key")).toThrow(/Unrecognized Figma reference/);
  });
});

describe("normalizeNodeId", () => {
  it("handles encoded node ids", () => {
    expect(normalizeNodeId("19%3A62607")).toBe("19:62607");
  });

  it("converts hyphen separated ids", () => {
    expect(normalizeNodeId("19-62607")).toBe("19:62607");
  });
});

describe("encodeNodeId", () => {
  it("encodes colon for query usage", () => {
    expect(encodeNodeId("19:62607")).toBe("19%3A62607");
  });
});

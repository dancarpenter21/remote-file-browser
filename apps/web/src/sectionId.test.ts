import { describe, expect, it } from "vitest";
import { createSectionId } from "./sectionId.js";

describe("createSectionId", () => {
  it("uses randomUUID when the page provides it", () => {
    expect(createSectionId({
      randomUUID: () => "uuid-from-secure-context",
      getRandomValues: (bytes) => bytes,
    })).toBe("uuid-from-secure-context");
  });

  it("falls back to getRandomValues on an insecure HTTP page", () => {
    expect(createSectionId({
      getRandomValues: (bytes) => {
        bytes.fill(0xab);
        return bytes;
      },
    })).toBe("section-abababababababababababababababab");
  });
});

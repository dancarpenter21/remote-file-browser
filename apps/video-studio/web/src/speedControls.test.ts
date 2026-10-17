import { describe, expect, it } from "vitest";
import { parseSpeedDraft } from "./speedControls.js";

describe("decimal speed entry", () => {
  it.each(["0.01", "0.125", "0.25", "0.333", "0.5", "0.75", "1", " 0.333123 "])("accepts %s without rounding", (draft) => {
    expect(parseSpeedDraft(draft)).toBe(Number(draft));
  });
  it.each(["", " ", ".", "-", "NaN", "Infinity", "-Infinity", "0", "-0.2", "0.009", "1.001", "0.3junk"])("rejects %j without producing a timeline speed", (draft) => {
    expect(parseSpeedDraft(draft)).toBeUndefined();
  });
});

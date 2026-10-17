import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recalledProjectHandoff, rememberProjectHandoff } from "./projectHandoff.js";

describe("project handoff recovery", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", { sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("recovers the latest handoff for each project without crossing projects", () => {
    expect(recalledProjectHandoff("one")).toBeUndefined();
    rememberProjectHandoff("one", "session-one");
    rememberProjectHandoff("two", "session-two");
    expect(recalledProjectHandoff("one")).toBe("session-one");
    expect(recalledProjectHandoff("two")).toBe("session-two");
    rememberProjectHandoff("one", "renewed-session");
    expect(recalledProjectHandoff("one")).toBe("renewed-session");
    expect(recalledProjectHandoff("two")).toBe("session-two");
  });

  it("allows launches when browser storage is blocked", () => {
    vi.stubGlobal("window", Object.defineProperty({}, "sessionStorage", { get() { throw new Error("Storage unavailable"); } }));
    expect(() => rememberProjectHandoff("one", "session")).not.toThrow();
    expect(recalledProjectHandoff("one")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import { RepeatToolReminder } from "../src/agent/repeat-reminder.ts";

describe("RepeatToolReminder", () => {
  it("reminds at 3, 5, and 8 identical calls and never blocks", () => {
    const reminder = new RepeatToolReminder();
    const notices: Array<string | null> = [];
    for (let i = 0; i < 8; i += 1) {
      notices.push(reminder.note("grep", { query: "mail", path: "src" }));
    }
    expect(notices.filter(Boolean)).toHaveLength(3);
    expect(notices[2]).toContain("repeating the exact same tool call");
    expect(notices[4]).toContain("consecutive_calls: 5");
    expect(notices[7]).toContain("consecutive_calls: 8");
  });

  it("treats the same object with different key order as identical", () => {
    const reminder = new RepeatToolReminder();
    reminder.note("grep", { path: "src", query: "mail" });
    reminder.note("grep", { query: "mail", path: "src" });
    expect(reminder.note("grep", { query: "mail", path: "src" })).toContain("repeating");
  });

  it("resets when the user starts a new instruction", () => {
    const reminder = new RepeatToolReminder();
    reminder.note("grep", { query: "mail" });
    reminder.note("grep", { query: "mail" });
    reminder.reset();
    expect(reminder.note("grep", { query: "mail" })).toBeNull();
    expect(reminder.note("grep", { query: "mail" })).toBeNull();
    expect(reminder.note("grep", { query: "mail" })).toContain("repeating");
  });
});

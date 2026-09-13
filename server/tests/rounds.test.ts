import { describe, expect, it } from "vitest";

import { countInvestigationRounds } from "../src/http/rounds.ts";

describe("countInvestigationRounds", () => {
  it("counts completed turns and ignores aborted ones", () => {
    expect(countInvestigationRounds([
      { type: "turn/start", data: { turn: 1 } },
      { type: "turn/end", data: { turn: 1, reason: "completed" } },
      { type: "turn/start", data: { turn: 2 } },
      { type: "turn/end", data: { turn: 2, reason: "aborted" } },
      { type: "turn/start", data: { turn: 3 } },
      { type: "turn/end", data: { turn: 3, reason: "completed" } },
    ])).toBe(2);
  });

  it("falls back to human user messages", () => {
    expect(countInvestigationRounds([
      { type: "user/message", data: { source: "human", content: "先查" } },
      { type: "user/message", data: { source: "steer", content: "改一下" } },
      { type: "user/message", data: { content: "再看" } },
    ])).toBe(2);
  });
});

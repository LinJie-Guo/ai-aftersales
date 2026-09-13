import { describe, expect, it } from "vitest";

import { sanitizeForJson, sanitizeText } from "../src/agent/json-safe.ts";

describe("sanitizeForJson", () => {
  it("strips NUL bytes that Postgres JSONB rejects", () => {
    expect(sanitizeText("ok\u0000still")).toBe("okstill");
    expect(sanitizeForJson({ summary: "a\u0000b", nested: { x: "c\u0000d" } })).toEqual({
      summary: "ab",
      nested: { x: "cd" },
    });
  });

  it("replaces mostly-binary dumps with a short notice", () => {
    const binary = `${"\u0000\u0001\u0002\u0005ATTR".repeat(40)}plain`;
    const out = sanitizeText(binary);
    expect(out).toContain("二进制");
    expect(out).not.toContain("\u0000");
  });
});

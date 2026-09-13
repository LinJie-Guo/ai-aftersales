import { describe, expect, it } from "vitest";

import { redactEventForClient, redactSensitiveText } from "../src/agent/redact.ts";
import { ToolRegistry } from "../src/agent/tools/registry.ts";

describe("tool pipeline", () => {
  it("runs independent tools in parallel", async () => {
    const order: string[] = [];
    const registry = new ToolRegistry(2);
    const slow = (name: string, ms: number) => {
      registry.register({
        name,
        description: name,
        parameters: { type: "object", properties: {} },
        async execute() {
          order.push(`start:${name}`);
          await new Promise((resolve) => setTimeout(resolve, ms));
          order.push(`end:${name}`);
          return { status: "success", summary: name };
        },
      });
    };
    slow("a", 40);
    slow("b", 40);
    const started = Date.now();
    const results = await registry.executeBatch(
      [
        { id: "1", name: "a", arguments: {} },
        { id: "2", name: "b", arguments: {} },
      ],
      { signal: new AbortController().signal, inject() {} },
    );
    expect(results.every((item) => item.status === "success")).toBe(true);
    expect(Date.now() - started).toBeLessThan(70);
    expect(order[0].startsWith("start")).toBe(true);
    expect(order[1].startsWith("start")).toBe(true);
  });

  it("serializes the same ssh resource lock", async () => {
    const registry = new ToolRegistry(4);
    const stamps: number[] = [];
    registry.register({
      name: "env_snapshot",
      description: "env",
      parameters: { type: "object", properties: {} },
      resourceKey: "ssh:c1",
      async execute() {
        stamps.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { status: "success", summary: "ok" };
      },
    });
    await registry.executeBatch(
      [
        { id: "1", name: "env_snapshot", arguments: { x: 1 } },
        { id: "2", name: "env_snapshot", arguments: { x: 2 } },
      ],
      { signal: new AbortController().signal, inject() {} },
    );
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(25);
  });

  it("keeps secrets in tool results for the model", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "bash",
      description: "bash",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { status: "success", summary: "es:\n  password: ljqc@1234\n" };
      },
    });
    const [result] = await registry.executeBatch(
      [{ id: "1", name: "bash", arguments: {} }],
      { signal: new AbortController().signal, inject() {} },
    );
    expect(result.summary).toContain("ljqc@1234");
  });

  it("redacts secrets only for the browser", () => {
    const raw = "es:\n  password: ljqc@1234\n";
    expect(redactSensitiveText(raw)).toContain("password: [REDACTED]");
    expect(redactSensitiveText(raw)).not.toContain("ljqc@1234");
    const event = redactEventForClient({
      seq: 1,
      type: "tool/result",
      data: { summary: raw },
    });
    expect(event.data.summary).toContain("password: [REDACTED]");
    expect(event.data.summary).not.toContain("ljqc@1234");
  });
});

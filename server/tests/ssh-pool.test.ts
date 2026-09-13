import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const counters = vi.hoisted(() => ({ connections: 0, active: 0, max: 0 }));
vi.mock("ssh2", () => ({ Client: class extends EventEmitter {
  connect() { counters.connections++; queueMicrotask(() => this.emit("ready")); }
  end() { this.emit("close"); }
  exec(_command: string, cb: Function) {
    const stream = new EventEmitter() as any; stream.stderr = new EventEmitter();
    counters.active++; counters.max = Math.max(counters.max, counters.active);
    let done = false;
    stream.close = () => { if (!done) { done = true; counters.active--; stream.emit("close", 0); } };
    stream.signal = () => {};
    cb(null, stream);
    setTimeout(() => { if (!done) { stream.emit("data", Buffer.from("fixture")); stream.close(); } }, 20);
  }
} }));
import { runPooledSsh } from "../src/agent/tools/ssh-pool.ts";
describe("SSH transport reuse", () => {
  it("reuses one transport, limits channels to four, and cancels queued callers", async () => {
    const target = { host: "synthetic", username: "fixture", port: 22 };
    const jobs = Array.from({ length: 12 }, () => runPooledSsh(target, "fixed read", 2000));
    const abort = new AbortController();
    const cancelled = runPooledSsh(target, "must not execute", 2000, abort.signal);
    abort.abort(new Error("fixture cancel"));
    await expect(cancelled).rejects.toThrow("fixture cancel");
    expect((await Promise.all(jobs)).every((r) => r.output === "fixture")).toBe(true);
    expect(counters.connections).toBe(1); expect(counters.max).toBe(4); expect(counters.active).toBe(0);
  });
});

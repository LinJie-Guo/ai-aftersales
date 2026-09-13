import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { OpenAICompatibleTransport, consumeOpenAISseText, formatLlmError } from "../src/agent/llm.ts";
import { StreamingRedactor, registerSecret, redactEventForClient } from "../src/agent/redact.ts";
import { ArtifactStore } from "../src/agent/tools/artifacts.ts";
import { ToolRegistry } from "../src/agent/tools/registry.ts";
import { compactContext, contextSize } from "../src/agent/context.ts";
import { extractXlsxText } from "../src/agent/attachments.ts";
import { intersectScope } from "../src/agent/policy.ts";
import type { ChatMessage } from "../src/agent/types.ts";

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const event = (delta: object) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const request = () => ({ system: "test", messages: [] as ChatMessage[], tools: [], signal: new AbortController().signal });
async function collect(transport: OpenAICompatibleTransport, input = request()) { const chunks = []; for await (const chunk of transport.stream(input)) chunks.push(chunk); return chunks; }
async function artifacts() { const dir = await mkdtemp(path.join(os.tmpdir(), "aftersale-hardening-")); dirs.push(dir); return new ArtifactStore(dir); }

describe("runtime hardening regressions", () => {
  it("preserves repeated delta text and tool argument fragments", () => {
    const text = ["哈", "哈", "a", "a"].map((content) => event({ content })).join("");
    expect(consumeOpenAISseText(text).map((chunk) => chunk.type === "text" ? chunk.text : "").join("")).toBe("哈哈aa");
    const tool = (argumentsText: string) => event({ tool_calls: [{ index: 0, id: "t", function: { name: "read", arguments: argumentsText } }] });
    const chunks = consumeOpenAISseText(tool('{"file_path":"') + tool("aa") + tool('aa"}'));
    expect(chunks.at(-1)).toMatchObject({ toolCall: { argumentsText: '{"file_path":"aaaa"}' } });
  });

  it("does not retry an interrupted partial response", async () => {
    const fetcher = vi.fn(async () => new Response(event({ content: "partial" })));
    vi.stubGlobal("fetch", fetcher);
    await expect(collect(new OpenAICompatibleTransport({ baseUrl: "http://test", apiKey: "test", model: "test", retry: 2 }))).rejects.toThrow(/中断/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not retry an explicitly exhausted daily quota", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Daily limit reached" } }), { status: 429 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(collect(new OpenAICompatibleTransport({ baseUrl: "http://test", apiKey: "test", model: "test", retry: 2 }))).rejects.toThrow("Daily limit reached");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(formatLlmError(new Error("Daily limit reached"))).toContain("额度已耗尽");
  });

  it("cancels a stalled response body after first output", async () => {
    let cancelled = false;
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(event({ content: "start" }))); }, cancel() { cancelled = true; } })));
    await expect(collect(new OpenAICompatibleTransport({ baseUrl: "http://test", apiKey: "test", model: "test", idleTimeoutMs: 20, timeoutMs: 1000 }))).rejects.toThrow(/停滞超时/);
    expect(cancelled).toBe(true);
  });

  it("rejects unsupported images without sending a text-only retry", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const input = request();
    input.messages = [{ role: "user", id: "u", source: "human", content: "看图", images: [{ mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA", fileName: "a.png" }] }];
    await expect(collect(new OpenAICompatibleTransport({ baseUrl: "http://test", apiKey: "test", model: "test", imageInput: false }), input)).rejects.toThrow(/未被丢弃/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("redacts registered secrets across chunks and nested fields", () => {
    const secret = registerSecret("regression-secret-unique-54321");
    const redactor = new StreamingRedactor();
    const out = redactor.push("正常\n" + secret.slice(0, 12)) + redactor.push(secret.slice(12) + "\n完成") + redactor.push("", true);
    expect(out).not.toContain(secret); expect(out).toContain("[REDACTED]");
    expect(redactEventForClient({ nested: { api_key: "anything" } })).toEqual({ nested: { api_key: "[REDACTED]" } });
  });

  it("propagates tool deadline cancellation", async () => {
    let aborted = false;
    const registry = new ToolRegistry();
    registry.register({ name: "slow", description: "test", parameters: {}, timeoutMs: 15, execute: async (_, ctx) => new Promise((resolve) => ctx.signal.addEventListener("abort", () => { aborted = true; resolve({ status: "failed", summary: "cancelled" }); }, { once: true })) });
    const [result] = await registry.executeBatch([{ id: "x", name: "slow", arguments: {} }], { signal: new AbortController().signal });
    expect(aborted).toBe(true); expect(["failed", "timeout"]).toContain(result.status);
  });

  it("reads full artifacts with UTF-8 safe pagination and session isolation", async () => {
    const store = await artifacts(); const text = "中文🙂".repeat(2500); const ref = await store.persistText("code", text);
    let output = "", offset = 0;
    for (;;) { const page = await store.read(ref.id, offset, 503); output += page.text; offset = page.nextOffset; if (page.eof) break; }
    expect(output).toBe(text);
    await expect((await artifacts()).read(ref.id)).rejects.toThrow(/本会话/);
    await expect(store.read("../outside")).rejects.toThrow(/非法/);
  });

  it("bounds long context while preserving latest question and tool groups", async () => {
    const messages: ChatMessage[] = [{ role: "user", id: "first", source: "human", content: "initial goal" }];
    for (let i = 0; i < 20; i++) messages.push({ role: "assistant", content: "evidence ".repeat(500), toolCalls: [] });
    messages.push({ role: "user", id: "last", source: "human", content: "latest question" });
    const result = await compactContext(messages, 9000, await artifacts());
    expect(contextSize(result.messages)).toBeLessThanOrEqual(9000);
    expect(result.messages.at(-1)?.content).toBe("latest question"); expect(result.artifactId).toBeTruthy();
  });

  it("extracts numeric, text, and formula result cells from XLSX", async () => {
    const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet("订单");
    sheet.addRow(["客户", 123, { formula: "B1*2", result: 246 }]);
    const text = await extractXlsxText(Buffer.from(await book.xlsx.writeBuffer()));
    expect(text).toContain("A1=客户"); expect(text).toContain("B1=123"); expect(text).toContain("B1*2"); expect(text).toContain("246");
  });

  it("never broadens persisted customer scope", () => {
    expect(intersectScope(["a"], null)).toEqual(["a"]);
    expect(intersectScope(["a", "b"], ["b", "c"])).toEqual(["b"]);
    expect(intersectScope(null, [])).toEqual([]);
  });
});

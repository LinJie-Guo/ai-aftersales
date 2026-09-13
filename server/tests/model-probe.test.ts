import { afterEach, describe, expect, it, vi } from "vitest";
import { probeModelConnection, resolveProbeConfig } from "../src/http/model-probe.ts";

const saved = { baseUrl: "https://provider.test/v1", modelName: "saved-model", apiKey: "synthetic-provider-secret" };
afterEach(() => vi.unstubAllGlobals());
describe("model connection probe", () => {
  it("uses unsaved fields and masked stored key without mutating saved configuration", () => {
    expect(resolveProbeConfig({ model_name: "draft-model", api_key: "******" }, saved)).toEqual({ ...saved, modelName: "draft-model" });
    expect(saved.modelName).toBe("saved-model");
    expect(() => resolveProbeConfig({ base_url: "https://different.test/v1", api_key: "******" }, saved)).toThrow("不会向新地址发送");
    expect(resolveProbeConfig({ base_url: "https://different.test/v1", api_key: "new-key" }, saved).apiKey).toBe("new-key");
  });
  it.each([{ base_url: "" }, { model_name: "" }, { base_url: "file:///tmp/config" }, { base_url: "https://user:pass@provider.test/v1" }, { base_url: "https://provider.test/v1?key=x" }])("rejects invalid input %j", (body) => {
    expect(() => resolveProbeConfig(body, saved)).toThrow();
  });
  it("succeeds only when the requested draft model returns content", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] })));
    vi.stubGlobal("fetch", fetcher);
    const result = await probeModelConnection({ ...saved, modelName: "draft-model" });
    expect(result).toMatchObject({ ok: true, model: "draft-model", upstreamStatus: 200 });
    expect(JSON.parse((fetcher.mock.calls[0] as any)[1].body).model).toBe("draft-model");
    expect(JSON.stringify(result)).not.toContain(saved.apiKey);
  });
  it.each([
    [429, { error: { message: "Daily limit reached" } }, "额度已耗尽"],
    [401, { error: { message: "invalid key" } }, "拒绝认证"],
    [503, { error: { message: "unavailable" } }, "HTTP 503"],
    [200, { choices: [] }, "没有返回模型内容"],
    [200, { error: { message: "failed" } }, "错误响应"],
  ])("returns a visible message for HTTP %i", async (status, body, message) => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status }));
    expect(await probeModelConnection(saved)).toMatchObject({ ok: false, message: expect.stringContaining(message) });
  });
  it("reports malformed JSON and network failures without exposing secrets", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>not API</html>"));
    expect((await probeModelConnection(saved)).message).toContain("JSON");
    vi.stubGlobal("fetch", async () => { throw new Error(saved.apiKey); });
    const result = await probeModelConnection(saved);
    expect(result.message).toContain("无法连接"); expect(JSON.stringify(result)).not.toContain(saved.apiKey);
  });
  it("bounds stalled requests with a deadline", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true })));
    expect(await probeModelConnection(saved, { timeoutMs: 20 })).toMatchObject({ ok: false, message: expect.stringContaining("测试超时") });
  });
});

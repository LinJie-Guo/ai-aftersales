/** Same-provider loop comparison on isolated fixtures, not a full old-product benchmark.
 * Both loops get identical read/HTTP tools; only the new loop gets its outcome protocol.
 * Provider configuration is read-only. No customer connections or business writes. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { resolveTurnModel } from "../src/agent/models.ts";
import { sql } from "../src/db/client.ts";
import { ReactLoop } from "../src/agent/loop.ts";
import { MemorySession } from "../src/agent/session.ts";
import { ToolRegistry } from "../src/agent/tools/registry.ts";
import { ArtifactStore } from "../src/agent/tools/artifacts.ts";
import { createHttpTool } from "../src/agent/tools/http.ts";
import { finishTool } from "../src/agent/tools/finish.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../src/shared/index.ts";
import { redactSensitiveText } from "../src/agent/redact.ts";

assert.equal(process.env.AFTERSALE_LIVE_EVAL, "1");
const execute = promisify(execFile), reports: any[] = [];
const root = await mkdtemp(path.join(os.tmpdir(), "aftersale-generic-eval-"));
try {
  const runtime = await resolveTurnModel();
  const variants = [{ name: "current", Loop: ReactLoop, prompt: DEFAULT_SYSTEM_PROMPT }];
  if (process.env.BASELINE_SOURCE) {
    const src = process.env.BASELINE_SOURCE;
    const { ReactLoop: OldLoop } = await import(pathToFileURL(path.join(src, "agent/loop.ts")).href);
    const { DEFAULT_SYSTEM_PROMPT: oldPrompt } = await import(pathToFileURL(path.join(src, "shared/index.ts")).href);
    variants.unshift({ name: "baseline-loop", Loop: OldLoop, prompt: oldPrompt });
  }
  for (const variant of variants) for (const scenario of ["config-auth-data", "service-diagnosis"]) {
    const session = new MemorySession(`${variant.name}-${scenario}`), registry = new ToolRegistry();
    const artifacts = new ArtifactStore(path.join(root, session.id));
    let origin = "", configRead = false, dataRead = false, approvals = 0;
    const password = "synthetic + & # password", token = "synthetic-access-token-7654321";
    const observations: string[] = [];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, origin); const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      observations.push(`${req.method} ${url.pathname}`); res.setHeader("Content-Type", "application/json");
      if (scenario === "service-diagnosis" && url.pathname === "/health") {
        dataRead = true; res.statusCode = 503;
        return res.end(JSON.stringify({ status: "DOWN", components: { database: { status: "UP" }, search: { status: "DOWN", error: "connection refused at search.internal:9301" } } }));
      }
      if (url.pathname === "/session" && req.method === "POST") {
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        if (form.get("username") === "fixture" && form.get("password") === password) return res.end(JSON.stringify({ accessToken: token }));
      }
      if (url.pathname === "/settings" && url.searchParams.get("accessToken") === token) {
        configRead = true; return res.end(JSON.stringify({ dataUrl: `${origin}/catalog/count`, authorization: "Bearer accessToken", collection: "active_documents" }));
      }
      if (url.pathname === "/catalog/count" && req.headers.authorization === `Bearer ${token}` && configRead) {
        dataRead = true; return res.end(JSON.stringify({ count: 73, collection: "active_documents" }));
      }
      res.statusCode = 403; res.end(JSON.stringify({ error: "authentication required", hint: "service protocol is documented in /repo/README.md" }));
    }).listen(0, "127.0.0.1");
    await once(server, "listening"); origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const evidence = async (text: string) => { const ref = await artifacts.persistText("env", text); return { status: "success" as const, summary: ref.preview, artifactId: ref.id }; };
    registry.register({ name: "read", description: "读取本地代码文件。", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, async execute(args) {
      if (args.path !== "/repo/README.md") return { status: "failed", summary: "文件不存在；仓库入口 /repo/README.md" };
      return evidence(scenario === "config-auth-data"
        ? "Deployment: /opt/app/runtime.env. Configuration service protocol: POST /session with URL-encoded username/password returns accessToken. GET /settings with accessToken query parameter returns the current data URL and its authentication scheme. Catalog count is GET, collection active_documents."
        : "Deployment: /opt/app/runtime.env. Service health endpoint GET /health returns HTTP 200 if healthy, HTTP 503 with per-component diagnostics if unhealthy.");
    } });
    registry.register({ name: "remote_read", description: "从当前已授权服务器读取文件。", parameters: { type: "object", properties: { operation: { type: "string", enum: ["read"] }, path: { type: "string" } }, required: ["operation", "path"] }, async execute(args) {
      if (args.path !== "/opt/app/runtime.env" || args.operation !== "read") return { status: "failed", summary: "文件不存在；部署配置见仓库说明" };
      return evidence(scenario === "config-auth-data" ? `CONFIG_URL=${origin}\nCONFIG_USERNAME=fixture\nCONFIG_PASSWORD="${password}"` : `SERVICE_URL=${origin}`);
    } });
    const http = createHttpTool({ target: { host: "synthetic", username: "fixture", port: 22 }, artifacts,
      approve: async () => { approvals++; return true; },
      run: async (_target, command) => { const result = await execute("bash", ["-c", command], { timeout: 35000 }); return { output: result.stdout, exitCode: 0 }; },
    });
    registry.register({ ...http, async execute(args, ctx) {
      // Enforce fixture-only network access before executing the fixed curl builder.
      try { if (new URL(String(args.url)).origin !== origin || args.container !== undefined) throw new Error(); }
      catch { return { status: "denied", summary: "隔离评测仅允许当前 runtime.env 中的服务地址" }; }
      return http.execute(args, ctx);
    } });
    registry.register(artifacts.readTool());
    if (variant.name === "current") registry.register(finishTool(session));
    const start = Date.now(); let firstOutputMs: number | undefined;
    const loop = new variant.Loop(session, runtime.transport, registry, { systemPrompt: variant.prompt,
      maxSteps: 18, maxDurationMs: 180000, assembleExtraPrompt: () => "本地仓库入口 /repo/README.md。客户服务器已配置，当前允许环境排查。工具连接的是隔离测试环境，操作确认由评测器处理。",
      onTransient: () => { firstOutputMs ??= Date.now() - start; },
    });
    console.log(JSON.stringify({ started: variant.name, scenario, model: runtime.snapshot.modelName }));
    try {
      await loop.followup({ id: crypto.randomUUID(), role: "user", source: "human", content: scenario === "config-auth-data" ? "现在有效文档一共有多少条？请查出准确数量和依据。" : "帮我检查当前服务是否健康；如果不健康，指出具体故障组件和依据。不要修改环境。" });
      for await (const _ of loop.run()) {}
      const answer = String(session.events.findLast((e) => e.type === "assistant/message" && !(e.data.toolCalls as unknown[])?.length)?.data.content || "");
      const reason = session.events.findLast((e) => e.type === "turn/end")?.data.reason;
      const passed = dataRead && (scenario === "config-auth-data" ? configRead && /73/.test(answer) : /search|搜索/.test(answer) && /503|拒绝|refused/i.test(answer)) && !answer.includes(password) && !answer.includes(token) && (variant.name !== "current" || reason === "completed");
      const report = { variant: variant.name, scenario, passed, durationMs: Date.now() - start, firstOutputMs, approvals, observations,
        tools: session.events.filter((e) => e.type === "tool/call").map((e) => e.data.name), reason, answer: redactSensitiveText(answer).slice(0, 2400) };
      reports.push(report); console.log(JSON.stringify(report));
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
  console.log(JSON.stringify({ comparison: "same HTTP tools; loop and prompt comparison only", reports, customerConnections: 0, businessWrites: 0 }));
  if (reports.some((r) => r.variant === "current" && !r.passed)) process.exitCode = 1;
} catch (e) { console.error(redactSensitiveText(String(e))); process.exitCode = 1; }
finally { await rm(root, { recursive: true, force: true }); await sql.end(); }

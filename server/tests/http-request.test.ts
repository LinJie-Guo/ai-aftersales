import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { ArtifactStore } from "../src/agent/tools/artifacts.ts";
import { createHttpTool, httpRequestPlan } from "../src/agent/tools/http.ts";
import { createSshEnvTools } from "../src/agent/tools/ssh.ts";
import { CredentialVault } from "../src/agent/credentials.ts";

const execute = promisify(execFile), cleanups: (() => Promise<unknown>)[] = [];
const ctx = { signal: new AbortController().signal, inject() {} };
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

describe("generic HTTP transport", () => {
  it("performs real login -> token -> config -> data requests without service-specific code", async () => {
    const password = "fixture + & # ' $ no-shell", token = "fixture-access-token-123456789", requests: string[] = [];
    let origin = "";
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, origin); const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      requests.push(`${req.method} ${url.pathname}`); res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/auth/login" && req.method === "POST") {
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        if (form.get("username") === "fixture" && form.get("password") === password) return res.end(JSON.stringify({ accessToken: token }));
      }
      if (url.pathname === "/config" && url.searchParams.get("accessToken") === token) return res.end(JSON.stringify({ dataUrl: `${origin}/documents/_count`, filter: { deleted: false } }));
      if (url.pathname === "/documents/_count" && req.headers.authorization === `Bearer ${token}`) return res.end(JSON.stringify({ count: 42 }));
      res.statusCode = 403; res.end(JSON.stringify({ status: 403, message: "user not found" }));
    }).listen(0, "127.0.0.1"); await once(server, "listening"); origin = `http://127.0.0.1:${(server.address() as any).port}`;
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    const root = await mkdtemp(path.join(os.tmpdir(), "http-fixture-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
    const artifacts = new ArtifactStore(root), approve = vi.fn(async () => true);
    const captured = await artifacts.protect(JSON.stringify({ password })); const ref = captured.match(/cred_[\w-]+/)![0];
    const tool = createHttpTool({ target: { host: "fixture", port: 22, username: "fixture" }, artifacts, approve,
      run: async (_target, command) => { const { stdout } = await execute("bash", ["-c", command]); return { output: stdout, exitCode: 0 }; },
    });
    const wrong = await tool.execute({ url: `${origin}/config`, auth: { type: "basic", username: "fixture", passwordRef: ref } }, ctx);
    expect(wrong).toMatchObject({ status: "failed", data: { httpStatus: 403, failureKind: "authentication" } });
    const login = await tool.execute({ url: `${origin}/auth/login`, method: "POST", form: { username: "fixture", password: ref } }, ctx);
    expect(login.status).toBe("success"); expect(login.summary).not.toContain(token);
    const tokenRef = login.summary.match(/cred_[\w-]+/)![0];
    const config = await tool.execute({ url: `${origin}/config`, query: { accessToken: { secretRef: tokenRef } } }, ctx);
    expect(config.status).toBe("success"); expect(config.summary).toContain("documents/_count");
    const malformed = await tool.execute({ url: `${origin}/documents/_count`, headers: { Authorization: { secretRef: tokenRef, prefix: "Bearer" } } }, ctx);
    expect(malformed.data?.failureKind).toBe("validation");
    const count = await tool.execute({ url: `${origin}/documents/_count`, auth: { type: "bearer", tokenRef } }, ctx);
    expect(count.status).toBe("success"); expect(count.summary).toContain('"count":42');
    expect(approve).toHaveBeenCalledTimes(1); expect(requests).toHaveLength(4);
    expect(JSON.stringify(approve.mock.calls)).not.toContain(password);
    for (const result of [wrong, login, config, count]) {
      const stored = await readFile(path.join(root, "env", `${result.artifactId}.txt`), "utf8");
      const meta = await readFile(path.join(root, "env", `${result.artifactId}.json`), "utf8");
      expect(stored + meta).not.toContain(password); expect(stored + meta).not.toContain(token);
    }
  });
  it.each([
    { url: "file:///etc/passwd" }, { url: "http://user:secret@localhost" }, { url: "http://localhost", method: "TRACE" },
    { url: "http://localhost", headers: { Host: "other" } }, { url: "http://localhost", headers: { Authorization: "x\r\nInjected: y" } },
    { url: "http://localhost", query: { "x&evil": "y" } }, { url: "http://localhost", container: "x; reboot" },
    { url: "http://localhost", method: "POST", body: "x", form: {} }, { url: "http://localhost", auth: { type: "basic", username: "a:b", passwordRef: "no" } },
  ])("rejects invalid request before approval: %j", (args) => { expect(() => httpRequestPlan(args)).toThrow(); });
  it("does not send denied requests or ask approval for invalid credential parameters", async () => {
    const approve = vi.fn(async () => false), run = vi.fn();
    const root = await mkdtemp(path.join(os.tmpdir(), "http-denied-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
    const artifacts = new ArtifactStore(root), target = { host: "fixture", port: 22, username: "fixture" };
    const tool = createHttpTool({ target, artifacts, approve, run });
    expect((await tool.execute({ url: "http://localhost/login", method: "POST", form: { password: { secretRef: `cred_${crypto.randomUUID()}` } } }, ctx)).data?.failureKind).toBe("validation");
    expect(approve).not.toHaveBeenCalled();
    expect((await tool.execute({ url: "http://localhost/change", method: "POST", json: {} }, ctx)).status).toBe("denied");
    expect(approve).toHaveBeenCalledTimes(1); expect(run).not.toHaveBeenCalled();
    const bash = createSshEnvTools({ target, artifacts, customerId: "fixture", approve, run })[0];
    expect((await bash.execute({ command: "anything", credentialEnv: [{ variable: "BASH_ENV", ref: "bad" }] }, ctx)).data?.failureKind).toBe("validation");
    expect(approve).toHaveBeenCalledTimes(1);
    const vault = new CredentialVault(), safe = vault.capture("password: fixture-valid-value"), ref = safe.match(/cred_[\w-]+/)![0];
    expect(vault.bind([{ variable: "NACOS_PASSWORD", ref }])[0].variable).toBe("NACOS_PASSWORD");
    for (const variable of ["PATH", "LD_PRELOAD", "BASH_ENV", "ENV", "IFS", "PROMPT_COMMAND"]) expect(() => vault.bind([{ variable, ref }])).toThrow();
  });
  it("requires confirmation for mutating methods and public destinations", () => {
    expect(httpRequestPlan({ url: "http://localhost/config" }).needsApproval).toBe(false);
    expect(httpRequestPlan({ url: "https://example.com/config" }).needsApproval).toBe(true);
    expect(httpRequestPlan({ url: "http://10.external.example/config" }).needsApproval).toBe(true);
    expect(httpRequestPlan({ url: "http://192.168.external.example/config" }).needsApproval).toBe(true);
    expect(httpRequestPlan({ url: "http://localhost/login", method: "POST" }).needsApproval).toBe(true);
  });
  it("accepts direct credential references and rejects malformed authorization before sending", () => {
    const ref = `cred_${crypto.randomUUID()}`;
    const plan = httpRequestPlan({ url: "http://localhost/login", method: "POST", form: { password: ref } });
    expect(plan.bindings).toEqual([{ variable: "CRED_HTTP_0", ref }]);
    expect(plan.command).not.toContain(ref);
    expect(() => httpRequestPlan({ url: "http://localhost", headers: { Authorization: { secretRef: ref, prefix: "Bearer" } } })).toThrow("缺少空格");
    expect(() => httpRequestPlan({ url: "http://localhost", query: { token: "[REDACTED]" } })).toThrow("脱敏占位符");
  });
});

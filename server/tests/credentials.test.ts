import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { CredentialVault } from "../src/agent/credentials.ts";
import { ArtifactStore } from "../src/agent/tools/artifacts.ts";
import { createSshEnvTools, classifyCommandFailure, buildRemoteCommand } from "../src/agent/tools/ssh.ts";
import { ToolRegistry } from "../src/agent/tools/registry.ts";
import { ReactLoop } from "../src/agent/loop.ts";
import { MemorySession, deriveMessages } from "../src/agent/session.ts";

const execute = promisify(execFile), dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const ctx = () => ({ signal: new AbortController().signal, inject() {} });

describe("safe credential execution", () => {
  it("captures values as session-scoped references, not plaintext", () => {
    const vault = new CredentialVault();
    const output = vault.capture('NACOS_PASSWORD="fixture-credential-123"\npassword: ${CONFIG_PASSWORD}\npassword: ENC(encrypted)');
    const ref = output.match(/cred_[\w-]+/)![0];
    expect(output).not.toContain("fixture-credential-123");
    expect(vault.bind([{ variable: "CRED_AUTH", ref }])[0].value).toBe("fixture-credential-123");
    expect(() => new CredentialVault().bind([{ variable: "CRED_AUTH", ref }])).toThrow(/无效|过期/);
    expect(() => vault.bind([{ variable: "BASH_ENV", ref }])).toThrow(/CRED_/);
    expect(output.match(/cred_[\w-]+/g)).toHaveLength(1);
  });

  it("carries a usable reference through real SSH-tool/artifact/event/model plumbing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aftersale-credential-test-")); dirs.push(dir);
    const artifacts = new ArtifactStore(dir), registry = new ToolRegistry(), session = new MemorySession("credential-test");
    const secret = "fixture-'quote-$(false)-`false`-$dollar";
    let transportCalls = 0;
    const [bash] = createSshEnvTools({ target: { host: "fixture", port: 22, username: "test" }, customerId: "fixture", artifacts,
      approve: async () => true,
      run: async (_target, command) => {
        if (transportCalls++ === 0) return { output: JSON.stringify({ password: secret }), exitCode: 0 };
        const { stdout } = await execute("bash", ["-c", command], { env: { ...process.env, TEST_EXPECTED: secret } });
        return { output: stdout, exitCode: 0 };
      },
    }); registry.register(bash);
    let requests = 0;
    const loop = new ReactLoop(session, { async *stream(input) {
      expect(JSON.stringify(input)).not.toContain(secret);
      if (requests++ === 0) yield { type: "tool_call", toolCall: { id: "read", name: "bash", argumentsText: JSON.stringify({ command: "read authorized config" }) } };
      else if (requests === 2) {
        const result = input.messages.findLast((message) => message.role === "tool")!;
        const ref = result.content.match(/cred_[\w-]+/)![0];
        yield { type: "tool_call", toolCall: { id: "query", name: "bash", argumentsText: JSON.stringify({ command: 'test "$CRED_AUTH" = "$TEST_EXPECTED" && printf \'{"count":42}\'', credentialEnv: [{ variable: "CRED_AUTH", ref }] }) } };
      } else yield { type: "text", text: "现场数量 42" };
    } }, registry);
    loop.followup({ id: "u", role: "user", source: "human", content: "count" });
    for await (const _ of loop.run()) { /* drain */ }
    expect(transportCalls).toBe(2);
    expect(JSON.stringify(session.events)).not.toContain(secret);
    expect(JSON.stringify(deriveMessages(session.events))).toContain('42');
    for (const event of session.events.filter((event) => event.type === "tool/result")) {
      const content = await readFile(path.join(dir, "env", `${event.data.artifactId}.txt`), "utf8");
      const meta = await readFile(path.join(dir, "env", `${event.data.artifactId}.json`), "utf8");
      expect(content + meta).not.toContain(secret);
    }
  });

  it("reports protocol errors and preserves pipeline failures", async () => {
    expect(classifyCommandFailure('{"error":"unauthorized","status":401}', 0)).toBe("authentication");
    expect(classifyCommandFailure("app.log: request returned status 401", 0)).toBeUndefined();
    expect(classifyCommandFailure("not found", 2)).toBe("command");
    await expect(execute("bash", ["-c", buildRemoteCommand("false | head -1")])).rejects.toMatchObject({ code: 1 });
  });

  it("rejects redacted placeholders before connecting", async () => {
    const [bash] = createSshEnvTools({ target: { host: "fixture", port: 22, username: "test" }, customerId: "fixture", artifacts: new ArtifactStore("/tmp/unused-credential-test"), run: async () => { throw new Error("must not connect"); } });
    const result = await bash.execute({ command: 'curl -u "user:[REDACTED]" http://fixture' }, ctx());
    expect(result).toMatchObject({ status: "failed", data: { failureKind: "credentials" } });
  });
  it("redacts short credentials in subsequent output and bounds scanning long words", () => {
    const vault = new CredentialVault();
    expect(vault.capture("password: z9q4")).not.toContain("z9q4");
    expect(vault.capture("unexpected echo z9q4")).not.toContain("z9q4");
    const start = Date.now();
    vault.capture("a".repeat(256 * 1024));
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

import { Client } from "ssh2";
import { runPooledSsh } from "./ssh-pool.ts";
import { readonlyRoute } from "./readonly-route.ts";

import type { ToolSpec } from "./types.ts";

import type { ArtifactStore } from "./artifacts.ts";

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  privateKey?: string;
}

const OUTPUT_LIMIT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;

export function createSshEnvTools(input: {
  target: SshTarget | null;
  workdir?: string;
  artifacts: ArtifactStore;
  customerId: string;
  run?: typeof execSsh;
  approve?: (tool: string, command: string, signal: AbortSignal) => Promise<boolean>;
  readOnly?: ToolSpec["execute"];
}): ToolSpec[] {
  const defaultWorkdir = input.workdir?.trim() || undefined;
  return [
    {
      name: "bash",
      description:
        "在客户机通过 SSH 执行一条需要用户逐条审批的 bash 命令。普通只读检查优先 remote_read，直接 ES 查询优先 es_query。"
        + "每次调用都是新 shell，不保留上次的 cwd/变量；需要目录时传 workdir，不要依赖上一次的 cd。"
        + "远程文件和目录必须优先 remote_read；本工具仅作为受限工具无法完成时的审批入口。简单读取命令会转交 remote_read，按其分页规则返回，不原样执行 shell。非零退出码标记为失败。"
        + "配置中的敏感值使用 cred_ 引用；credentialEnv 可绑定 CRED_ 变量或以 PASSWORD/TOKEN/SECRET 等结尾的应用凭据变量，命令用双引号引用。HTTP 服务优先 http_request，可直接传凭据引用而不拼 shell。"
        + "查询 HTTP 时使用 curl --fail-with-body，避免把 401/403 当成功。不要猜默认密码、打印凭据或使用 [REDACTED] 认证。",
      parameters: objectSchema({
        command: { type: "string", description: "要执行的 bash 命令。" },
        description: {
          type: "string",
          description: "这步在做什么，5–10 个字，给界面展示。",
        },
        workdir: {
          type: "string",
          description: "本次命令的工作目录。默认是客户配置的工作目录；相对路径相对该目录解析。",
        },
        timeoutMs: { type: "integer", description: "超时毫秒。默认 45000。" },
        credentialEnv: { type: "array", maxItems: 16, description: "将凭据引用绑定为应用环境变量，如 [{variable:'APP_PASSWORD',ref:'cred_...'}]，命令使用 \"$APP_PASSWORD\"。禁止 BASH_ENV/PATH 等 shell 控制变量。", items: { type: "object", properties: { variable: { type: "string", maxLength: 64, pattern: "^(?:CRED_[A-Z0-9_]+|[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|API_KEY|SECRET))$" }, ref: { type: "string" } }, required: ["variable", "ref"], additionalProperties: false } },
      }, ["command"]),
      resourceKey: `ssh:${input.customerId}`,
      timeoutMs: 420_000,
      async execute(args, ctx) {
        if (!input.target) return { status: "unavailable", summary: "SSH 通道未配置或凭据不可用", retryable: false };
        const command = str(args.command);
        if (!command.trim()) return { status: "failed", summary: "command 不能为空" };
        const workdir = resolveWorkdir(str(args.workdir) || defaultWorkdir, defaultWorkdir);
        const timeoutMs = Math.min(115_000, num(args.timeoutMs, DEFAULT_TIMEOUT_MS));
        try {
          if (command.includes("[REDACTED]")) return { status: "failed", summary: "命令包含脱敏占位符，不能用于认证。请使用凭据引用绑定，或在同一远程命令内读取配置后直接使用变量。", data: { failureKind: "credentials" } };
          const readArgs = args.credentialEnv === undefined ? readonlyRoute(command, workdir) : undefined;
          if (readArgs && input.readOnly) {
            const result = await input.readOnly(readArgs, ctx);
            return { ...result, summary: `[已转为 remote_read 受限只读查询；完整内容按工具分页规则读取]\n${result.summary}`, data: { ...result.data, routedTool: "remote_read", routedArguments: readArgs } };
          }
          await input.artifacts.ready();
          try { input.artifacts.credentials.bind(args.credentialEnv); }
          catch (e) { return { status: "failed", summary: `凭据参数无效：${String(e)}`, data: { failureKind: "validation" } }; }
          if (!(await input.approve?.("bash", JSON.stringify({ command, workdir, credentialEnv: args.credentialEnv }), ctx.signal))) return { status: "denied", summary: "此 Bash 命令未获用户批准，未执行。请使用受限只读工具或说明需要批准的原因。" };
          const bindings = input.artifacts.credentials.bind(args.credentialEnv);
          const remote = buildRemoteCommand(command, workdir, bindings);
          const ran = await (input.run ?? execSsh)(input.target, remote, timeoutMs, ctx.signal);
          const text = ran.exitCode === 0 ? ran.output : `${ran.output}\n[exit code: ${ran.exitCode}]`;
          const ref = await input.artifacts.persistText("env", text, { tool: "bash", command, workdir, description: str(args.description) });
          const failureKind = classifyCommandFailure(ran.output, ran.exitCode);
          return { status: failureKind ? "failed" : "success", summary: ref.preview, artifactId: ref.id, data: { exitCode: ran.exitCode, ...(failureKind ? { failureKind } : {}) } };
        } catch (error) {
          return { status: "failed", summary: `bash 失败：${translateSshError(error)}` };
        }
      },
    },
  ];
}

export function buildRemoteCommand(command: string, workdir?: string, bindings: Array<{ variable: string; value: string }> = []): string {
  const exports = bindings.map(({ variable, value }) => `export ${variable}=${sh(value)}`).join("; ");
  const script = ["set -o pipefail", exports, workdir ? `cd ${sh(workdir)} || exit $?` : "", command].filter(Boolean).join("\n");
  return `bash -c ${sh(script)}`;
}

export function classifyCommandFailure(output: string, exitCode: number): string | undefined {
  // Only explicit protocol/exception markers, not arbitrary mentions of numbers
  // in log searches, are classified as authentication failures.
  const body = output.trim();
  if (/^HTTP\/\S+\s+(401|403)\b/.test(body) || body.startsWith("{") && /"(?:status|statusCode)"\s*:\s*(401|403)\b|"type"\s*:\s*"security_exception"/.test(body)) return "authentication";
  if (exitCode !== 0) return /command not found|No such file or directory/i.test(output) ? "missing-resource" : "command";
  return undefined;
}

export function resolveWorkdir(workdir: string | undefined, base?: string): string | undefined {
  if (!workdir?.trim()) return base;
  if (workdir.startsWith("/")) return workdir;
  if (!base) return workdir;
  return `${base.replace(/\/$/, "")}/${workdir}`;
}

export function translateSshError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.replace(/\s+/g, " ").trim();
  if (/^SSH 连接失败|^bash 失败|未配置|连接超时|拒绝可能|不能为空|公钥认证失败|连接被拒绝|无法解析|网络不可达|私钥/.test(text)) {
    return text;
  }
  if (/All configured authentication methods failed|Permission denied|authentication methods/i.test(text)) {
    return "公钥认证失败：当前私钥未被目标机 authorized_keys 接受。请在客户信息里粘贴能登录该机的私钥，或把本私钥对应的公钥追加到服务器 ~/.ssh/authorized_keys。";
  }
  if (/Cannot parse privateKey|Unsupported key format|encrypted|passphrase|dek-info|proc-type/i.test(text)) {
    return "私钥格式无效或已加密。请粘贴未加密的完整 PEM（-----BEGIN … PRIVATE KEY-----）。";
  }
  if (/Timed out|ETIMEDOUT|readyTimeout|Connection timed out/i.test(text)) {
    return "连接超时，目标机无响应。请检查环境 IP、端口和网络。";
  }
  if (/ECONNREFUSED|connect ECONNREFUSED/i.test(text)) {
    return "连接被拒绝，目标 SSH 端口未开放。";
  }
  if (/ENOTFOUND|getaddrinfo|Could not resolve/i.test(text)) {
    return "无法解析主机名，请检查环境 IP。";
  }
  if (/EHOSTUNREACH|ENETUNREACH|No route to host/i.test(text)) {
    return "网络不可达，本机到目标机不通。";
  }
  if (/Handshake|no matching (key exchange|cipher|mac|host key)/i.test(text)) {
    return "SSH 协议协商失败，目标机算法与本机不兼容。";
  }
  return `SSH 连接失败：${text}`;
}

export function probeSsh(target: SshTarget): Promise<void> {
  if (!target.privateKey?.trim()) return Promise.reject(new Error("未配置 SSH 私钥"));
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const fail = (error: unknown) => reject(new Error(translateSshError(error)));
    const timer = setTimeout(() => {
      conn.end();
      fail(new Error("连接超时，目标机无响应。请检查环境 IP、端口和网络。"));
    }, 10_000);
    conn
      .on("ready", () => {
        clearTimeout(timer);
        conn.end();
        resolve();
      })
      .on("error", (error) => {
        clearTimeout(timer);
        fail(error);
      })
      .connect({
        host: target.host,
        port: target.port,
        username: target.username,
        privateKey: target.privateKey,
        readyTimeout: 10_000,
      });
  });
}

export function execSsh(target: SshTarget, command: string, timeoutMs: number, signal?: AbortSignal): Promise<{ output: string; exitCode: number }> {
  return runPooledSsh(target, command, timeoutMs, signal).catch((error) => { throw new Error(translateSshError(error)); });
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

import { isIP } from "node:net";
import type { ArtifactStore } from "./artifacts.ts";
import { buildRemoteCommand, execSsh, type SshTarget } from "./ssh.ts";
import type { ToolSpec } from "./types.ts";

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const marker = "\n__AFTERSALE_HTTP_STATUS__:";
const secretValue = { anyOf: [{ type: "string", description: "普通文本或 cred_ 凭据引用；引用会在执行时解析，不能传脱敏占位符" }, { type: "object", properties: { secretRef: { type: "string" }, prefix: { type: "string", description: "可选固定前缀，包含所需分隔符；Bearer 鉴权优先使用 auth.type=bearer" } }, required: ["secretRef"], additionalProperties: false }] };
const fields = { type: "object", additionalProperties: secretValue };

/** Request builder for any HTTP service, with no product-specific login logic.
 * References travel through stdin/env, never model-visible plaintext. No redirects. */
export function httpRequestPlan(args: Record<string, unknown>) {
  const url = new URL(String(args.url || ""));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || /[\r\n\0]/.test(String(args.url))) throw new Error("url 必须是无内嵌账号密码的 HTTP(S) 地址");
  const method = String(args.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)) throw new Error("不支持的 HTTP method");
  if ([args.form, args.json, args.body].filter((v) => v !== undefined).length > 1) throw new Error("form、json、body 只能选择一种");
  if (["GET", "HEAD"].includes(method) && (args.form !== undefined || args.body !== undefined || args.json !== undefined)) throw new Error("GET/HEAD 请求体请改用明确方法；结构化查询可使用 es_query");
  const bindings: { variable: string; ref: string }[] = [];
  const value = (v: unknown): string => {
    if (typeof v === "string" && /^cred_[0-9a-f-]{36}$/.test(v)) return value({ secretRef: v });
    if (typeof v === "string" && /\[REDACTED(?:[^\]]*)\]/i.test(v)) throw new Error("不能发送脱敏占位符，请使用配置中返回的 cred_ 凭据引用");
    if (typeof v === "string" && v.length <= 16000 && !/[\0\r\n]/.test(v)) return quote(v);
    if (v && typeof v === "object" && Object.keys(v).every((key) => ["secretRef", "prefix"].includes(key)) && /^cred_[0-9a-f-]{36}$/.test(String((v as any).secretRef))) {
      const prefix = (v as any).prefix ?? "";
      if (typeof prefix !== "string" || prefix.length > 100 || /[\r\n\0]/.test(prefix)) throw new Error("凭据前缀无效");
      const variable = `CRED_HTTP_${bindings.length}`;
      bindings.push({ variable, ref: String((v as any).secretRef) });
      return `${quote(prefix)}"$${variable}"`;
    }
    throw new Error("请求字段只能是单行字符串或 {secretRef: cred_引用}");
  };
  const entries = (v: unknown): [string, unknown][] => {
    if (v === undefined) return [];
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length > 32) throw new Error("请求字段必须是最多 32 项的对象");
    return Object.entries(v);
  };
  const options: string[] = [];
  for (const [key, val] of entries(args.query)) {
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(key)) throw new Error("query 参数名无效");
    options.push(`--url-query ${quote(`${key}=`)}${value(val)}`);
  }
  for (const [key, val] of entries(args.headers)) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(key) || /^(host|content-length|transfer-encoding|proxy-authorization|connection)$/i.test(key)) throw new Error("header 名称无效或不允许覆盖");
    if (key.toLowerCase() === "authorization" && val && typeof val === "object" && /^(Bearer|Basic)$/i.test(String((val as any).prefix))) throw new Error("Authorization 方案与凭据之间缺少空格；Bearer 令牌请使用 auth: {type: 'bearer', tokenRef: 'cred_引用'}，Basic 请使用 auth: {type: 'basic', username, passwordRef}");
    options.push(`--header ${quote(`${key}: `)}${value(val)}`);
  }
  if (args.auth !== undefined) {
    const auth = args.auth as Record<string, unknown>;
    if (!auth || typeof auth !== "object" || entries(args.headers).some(([key]) => key.toLowerCase() === "authorization")) throw new Error("auth 无效或与 Authorization header 冲突");
    if (auth.type === "basic" && typeof auth.username === "string" && !/[\r\n\0:]/.test(auth.username)) options.push(`--user ${quote(`${auth.username}:`)}${value({ secretRef: auth.passwordRef })}`);
    else if (auth.type === "bearer") options.push(`--header 'Authorization: Bearer '${value({ secretRef: auth.tokenRef })}`);
    else throw new Error("auth 需要 basic 的 username/passwordRef 或 bearer 的 tokenRef");
  }
  if (args.form !== undefined) for (const [key, val] of entries(args.form)) {
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(key)) throw new Error("form 参数名无效");
    options.push(`--data-urlencode ${quote(`${key}=`)}${value(val)}`);
  }
  if (args.json !== undefined) {
    const body = JSON.stringify(args.json);
    if (body.length > 16000 || /"secretRef"\s*:/.test(body)) throw new Error("json 超过 16KB 或包含未支持的嵌套凭据；凭据请放入 headers/form/query");
    options.push(`--header 'Content-Type: application/json' --data-binary ${quote(body)}`);
  }
  if (args.body !== undefined) {
    if (typeof args.body !== "string" || args.body.length > 16000 || args.body.includes("\0")) throw new Error("body 必须是不超过 16KB 的文本");
    options.push(`--data-binary ${quote(args.body)}`);
  }
  if (bindings.length > 16) throw new Error("每个请求最多引用 16 个凭据");
  // GET/HEAD/OPTIONS are read operations. All other methods and public targets
  // still require one explicit approval; a claimed 'login' purpose cannot bypass it.
  const h = url.hostname;
  const privateHost = h === "localhost" || h === "[::1]" || (isIP(h) === 4 && /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) || /^[a-zA-Z][a-zA-Z0-9-]*$/.test(h);
  let command = `curl -q --silent --show-error --max-time 30 --max-filesize 262144 --proto '=http,https' ${method === "HEAD" ? "--head" : `--request ${method}`} ${options.join(" ")} --write-out ${quote(`${marker}%{http_code}`)} -- ${quote(url.toString())}`;
  if (args.container !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(String(args.container))) throw new Error("container 标识无效");
  return { command, bindings, method, url: url.toString(), target: url.origin, path: url.pathname, container: args.container ? String(args.container) : undefined, needsApproval: !privateHost || !["GET", "HEAD", "OPTIONS"].includes(method) };
}

export function createHttpTool(input: { target: SshTarget | null; artifacts: ArtifactStore; run?: typeof execSsh; approve?: (tool: string, command: string, signal: AbortSignal) => Promise<boolean> }): ToolSpec {
  return {
    name: "http_request",
    description: "从客户服务器（或指定容器）请求任意 HTTP 服务，返回 HTTP 状态与响应正文。支持 query、headers、form、json、body；凭据字段用 {secretRef: cred_引用}，响应令牌会自动变为新的凭据引用。按服务实际协议组合登录和后续请求，不假设 Basic Auth。内网 GET/HEAD/OPTIONS 无需审批，其他方法/外网需确认；不跟随重定向。",
    parameters: { type: "object", properties: { url: { type: "string" }, method: { type: "string", enum: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] }, query: fields, headers: fields, form: fields, auth: { type: "object", properties: { type: { type: "string", enum: ["basic", "bearer"] }, username: { type: "string" }, passwordRef: { type: "string" }, tokenRef: { type: "string" } }, required: ["type"], additionalProperties: false }, json: { type: "object" }, body: { type: "string" }, container: { type: "string" } }, required: ["url"], additionalProperties: false }, timeoutMs: 390000,
    async execute(args, ctx) {
      if (!input.target) return { status: "unavailable", summary: "SSH 未配置" };
      let plan: ReturnType<typeof httpRequestPlan>;
      let bindings: { variable: string; value: string }[];
      try { plan = httpRequestPlan(args); await input.artifacts.ready(); bindings = input.artifacts.credentials.bind(plan.bindings); }
      catch (e) { return { status: "failed", summary: `HTTP 参数无效：${String(e)}`, data: { failureKind: "validation" } }; }
      if (plan.needsApproval && !(await input.approve?.("http_request", JSON.stringify({ ...args, reason: "此方法可能改变服务状态或访问外部地址" }), ctx.signal))) return { status: "denied", summary: "HTTP 请求未获批准，未发送。", data: { failureKind: "permission", target: plan.target, operation: `${plan.method} ${plan.path}` } };
      try {
        ctx.signal.throwIfAborted();
        // A reference can expire while waiting for approval; resolve once more.
        bindings = input.artifacts.credentials.bind(plan.bindings);
        let command = buildRemoteCommand(plan.command, undefined, bindings);
        if (plan.container) {
          const exports = bindings.map(({ variable, value }) => `export ${variable}=${quote(value)}`).join("\n");
          command = `docker exec ${quote(plan.container)} sh -c ${quote(`${exports}\n${plan.command}`)}`;
        }
        const ran = await (input.run ?? execSsh)(input.target, command, 45000, ctx.signal);
        const at = ran.output.lastIndexOf(marker), httpStatus = at < 0 ? 0 : Number(ran.output.slice(at + marker.length).trim());
        const body = at < 0 ? ran.output : ran.output.slice(0, at);
        const success = ran.exitCode === 0 && httpStatus >= 200 && httpStatus < 300;
        const failureKind = success ? undefined : [401, 403].includes(httpStatus) ? "authentication" : httpStatus ? "http" : "network";
        const ref = await input.artifacts.persistText("env", body, { tool: "http_request", arguments: args, httpStatus, exitCode: ran.exitCode });
        return { status: success ? "success" : "failed", summary: `HTTP ${httpStatus || "未收到响应"}\n${ref.preview}`, artifactId: ref.id,
          data: { httpStatus, exitCode: ran.exitCode, failureKind, target: plan.target, operation: `${plan.method} ${plan.path}`, authScope: JSON.stringify(plan.bindings.map((item) => item.ref).sort()), observedAt: new Date().toISOString() } };
      } catch (e) { return { status: "failed", summary: `HTTP 请求失败：${String(e)}`, data: { failureKind: "network", target: plan.target, operation: `${plan.method} ${plan.path}` } }; }
    },
  };
}

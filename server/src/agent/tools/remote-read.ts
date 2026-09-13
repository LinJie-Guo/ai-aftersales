import { isIP } from "node:net";
import type { ArtifactStore } from "./artifacts.ts";
import { buildRemoteCommand, classifyCommandFailure, execSsh, type SshTarget } from "./ssh.ts";
import type { ToolSpec } from "./types.ts";

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
function filePath(value: unknown): string {
  const p = String(value || "");
  if (!p.startsWith("/") || /[\0\r\n]/.test(p) || p.split("/").includes("..") || /^\/(dev|proc|sys)(\/|$)/.test(p)) throw new Error("需要普通文件的绝对路径；不允许设备、进程内存或路径穿越");
  return p;
}
function name(value: unknown): string {
  const valueString = String(value || "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(valueString)) throw new Error("容器标识无效");
  return valueString;
}
function number(value: unknown, fallback: number, max: number) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error("读取范围无效");
  return n;
}

/** No caller-supplied shell source: every executable/option is selected here. */
export function remoteReadCommand(args: Record<string, unknown>): string {
  const op = String(args.operation), limit = number(args.limit, 120, 1000);
  const prefix = args.container ? `docker exec ${quote(name(args.container))} ` : "";
  if (op === "containers") return "docker ps --format '{{json .}}'";
  if (op === "processes") return "ps -eo pid,ppid,user,comm";
  if (op === "inspect") return `docker inspect -- ${quote(name(args.container))}`;
  if (op === "logs") return `docker logs --tail ${limit} -- ${quote(name(args.container))}`;
  const p = quote(filePath(args.path));
  if (op === "list") return `${prefix}ls -la -- ${p}`;
  if (op === "read") { const start = number(args.offset, 1, 100000); return `${prefix}sed -n '${start},${start + limit - 1}p' -- ${p}`; }
  if (op === "search") {
    const pattern = String(args.pattern || "");
    if (!pattern || pattern.length > 512 || /[\0\r\n]/.test(pattern)) throw new Error("搜索内容无效");
    return `${prefix}grep -R -n -F -m ${Math.min(limit, 100)} -- ${quote(pattern)} ${p}`;
  }
  throw new Error("不支持的只读操作");
}

export function esReadRequest(args: Record<string, unknown>) {
  const url = new URL(String(args.baseUrl || ""));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("ES 地址只能包含 http(s) 主机和端口，不允许凭据或自定义接口路径");
  const index = String(args.index || "*");
  if (!/^[a-zA-Z0-9_*?,.-]{1,200}$/.test(index) || index === "." || index === "..") throw new Error("ES 索引表达式无效");
  const operation = String(args.operation || "count");
  if (!["count", "search", "mapping", "indices"].includes(operation)) throw new Error("仅允许 ES 只读查询");
  const query = args.query;
  if (query !== undefined && (!query || typeof query !== "object" || Array.isArray(query))) throw new Error("query 必须是 ES 查询对象");
  if (JSON.stringify(query ?? {}).length > 16000 || containsScript(query)) throw new Error("只读查询不允许脚本，查询体不能超过 16KB");
  const body = operation === "count" ? { ...(query ? { query } : {}) } : operation === "search" ? { query: query ?? { match_all: {} }, size: number(args.size, 10, 100), timeout: "10s", track_total_hits: true } : undefined;
  const endpoint = operation === "indices" ? "/_cat/indices?format=json&h=index,docs.count,status" : `/${encodeURIComponent(index)}/_${operation}`;
  return { url: `${url.origin}${endpoint}`, host: url.hostname, body };
}
function containsScript(value: unknown): boolean {
  return !!value && typeof value === "object" && Object.entries(value).some(([key, child]) => /script|runtime_mapping/i.test(key) || containsScript(child));
}
function privateHost(host: string): boolean {
  if (host === "localhost" || host === "[::1]") return true;
  if (isIP(host) === 4) { const n = host.split(".").map(Number); return n[0] === 10 || n[0] === 127 || n[0] === 192 && n[1] === 168 || n[0] === 172 && n[1] >= 16 && n[1] <= 31; }
  return /^[a-zA-Z][a-zA-Z0-9-]*$/.test(host);
}

export function createRemoteReadTools(input: { target: SshTarget | null; artifacts: ArtifactStore; run?: typeof execSsh; approve?: (tool: string, command: string, signal: AbortSignal) => Promise<boolean> }): ToolSpec[] {
  const execute = async (command: string, args: Record<string, unknown>, signal: AbortSignal, bindings: Array<{ variable: string; value: string }> = [], tool = "remote_read") => {
    if (!input.target) return { status: "unavailable" as const, summary: "SSH 未配置" };
    const ran = await (input.run ?? execSsh)(input.target, buildRemoteCommand(command, undefined, bindings), 45000, signal);
    const noMatch = tool === "remote_read" && args.operation === "search" && ran.exitCode === 1;
    const failureKind = noMatch ? undefined : classifyCommandFailure(ran.output, ran.exitCode);
    const ref = await input.artifacts.persistText("env", noMatch ? "未找到匹配" : ran.output, { tool, arguments: args, source: input.target.host, exitCode: ran.exitCode });
    return { status: failureKind ? "failed" as const : "success" as const, summary: ref.preview, artifactId: ref.id, data: { source: "现场只读查询", host: input.target.host, operation: args.operation, index: args.index, query: args.query, observedAt: new Date().toISOString(), exitCode: ran.exitCode, failureKind } };
  };
  return [
    { name: "remote_read", description: "无需命令审批的现场只读工具。读取服务器/容器文件、搜索配置、列目录、查看进程、容器、inspect 或日志。与本地源码 read/grep 分离；不执行脚本。默认 120 行，超长输出保存在 Artifact。", parameters: { type: "object", properties: { operation: { type: "string", enum: ["list", "read", "search", "processes", "containers", "inspect", "logs"] }, path: { type: "string" }, pattern: { type: "string" }, container: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["operation"], additionalProperties: false }, timeoutMs: 60000,
      async execute(args, ctx) { try { return await execute(remoteReadCommand(args), args, ctx.signal); } catch (e) { return { status: "failed", summary: String(e) }; } } },
    { name: "es_query", description: "通过客户服务器直接只读查询 Elasticsearch。根据源码与配置确定 baseUrl/index/query；支持 count/search/mapping/indices。不经业务 API，不允许写入或脚本。passwordRef/apiKeyRef 使用已读取配置中的 cred_ 引用，不传密码。外部地址需审批。", parameters: { type: "object", properties: { baseUrl: { type: "string" }, operation: { type: "string", enum: ["count", "search", "mapping", "indices"] }, index: { type: "string" }, query: { type: "object" }, size: { type: "integer" }, username: { type: "string" }, passwordRef: { type: "string" }, apiKeyRef: { type: "string" } }, required: ["baseUrl", "operation"], additionalProperties: false }, timeoutMs: 390000,
      async execute(args, ctx) {
        try {
          const request = esReadRequest(args);
          if (!privateHost(request.host) && !(await input.approve?.("es_query", JSON.stringify(args), ctx.signal))) return { status: "denied", summary: "外部 ES 地址未获批准，未发送请求" };
          if (args.passwordRef && args.apiKeyRef) throw new Error("只能选择一种认证方式");
          await input.artifacts.ready();
          const ref = args.passwordRef || args.apiKeyRef;
          const bindings = input.artifacts.credentials.bind(ref ? [{ variable: "CRED_QUERY_SECRET", ref }] : undefined);
          const username = String(args.username || "");
          if (/[\0\r\n:]/.test(username)) throw new Error("用户名无效");
          const auth = args.passwordRef ? ` --user ${quote(username)}:"$CRED_QUERY_SECRET"` : args.apiKeyRef ? ' --header "Authorization: ApiKey $CRED_QUERY_SECRET"' : "";
          const body = request.body ? ` --header 'Content-Type: application/json' --data-binary ${quote(JSON.stringify(request.body))}` : "";
          const command = `curl -q --silent --show-error --fail-with-body --max-time 30 --max-filesize 262144 --request GET${auth}${body} -- ${quote(request.url)}`;
          return await execute(command, args, ctx.signal, bindings, "es_query");
        } catch (e) { return { status: "failed", summary: String(e) }; }
      } },
  ];
}

import { createHash } from "node:crypto";
import type { ToolCall, ToolResult } from "./tools/types.ts";

export class ProgressGuard {
  private seen = new Set<string>();
  private stalled = 0;
  reset() { this.seen.clear(); this.stalled = 0; }

  note(results: ToolResult[], calls: ToolCall[] = []): { warning?: string; stop?: boolean } {
    if (!results.length) return {};
    let novel = false;
    let observed = false;
    for (const [index, result] of results.entries()) {
      if (["investigation_state", "finish_task"].includes(calls[index]?.name)) continue;
      observed = true;
      const text = result.summary.replace(/\[Artifact [^\]]*\]|cred_[\w-]+/g, "").replace(/\b\d{4}-\d\d-\d\d[T ][\d:.+Z-]+/g, "<time>").replace(/\s+/g, " ").trim();
      const auth = result.data?.failureKind === "authentication" || /authentication required|认证失败|unauthorized|security_exception/i.test(text);
      const empty = /^(未找到匹配|未检索到相似知识)$/.test(text);
      const basis = auth ? `authentication-failure:${failureScope(result, calls[index])}` : empty ? `${calls[index]?.name}:${JSON.stringify(calls[index]?.arguments)}:${text}` : text;
      const fingerprint = createHash("sha256").update(basis).digest("hex");
      if (!this.seen.has(fingerprint)) { if (!auth || this.seen.size > 0) novel = true; this.seen.add(fingerprint); }
    }
    if (!observed) return {};
    if (this.seen.size > 128) this.seen = new Set([...this.seen].slice(-64));
    this.stalled = novel ? 0 : this.stalled + 1;
    if (this.stalled >= 6) return { stop: true };
    if (this.stalled >= 3) return { warning: "连续多步对同一目标/方法/凭据没有新增证据。检查参数、执行位置、认证协议与服务响应，选择有依据的新方法或来源。不要只重复原请求；仍有已授权步骤就继续，否则明确报告阻塞。" };
    return {};
  }
}

function failureScope(result: ToolResult, call?: ToolCall): string {
  const args = call?.arguments ?? {};
  const command = String(args.command || "");
  const urls = command.match(/https?:\/\/[^\s"'<>]+/g)?.map((value) => { try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return value; } }) ?? [];
  const method = args.method ?? command.match(/(?:-X|--request)\s+([A-Z]+)/)?.[1] ?? (/(?:--data|-d)\s/.test(command) ? "POST" : "GET");
  const refs = JSON.stringify(args).match(/cred_[0-9a-f-]{36}/g)?.sort() ?? [];
  return JSON.stringify({ name: call?.name, target: result.data?.target ?? args.baseUrl ?? args.url ?? urls, operation: result.data?.operation ?? args.operation ?? method, auth: result.data?.authScope ?? refs, container: args.container });
}

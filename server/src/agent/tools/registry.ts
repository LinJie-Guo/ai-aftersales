import type { ToolCall, ToolResult, ToolRunContext, ToolSpec } from "./types.ts";

export class ToolRegistry {
  private readonly specs = new Map<string, ToolSpec>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly disabled = new Set<string>();

  setEnabled(name: string, enabled: boolean) {
    if (enabled) this.disabled.delete(name);
    else this.disabled.add(name);
  }

  beginTurn() {}
  hasTerminal() { return [...this.specs.values()].some((spec) => spec.terminal && !this.disabled.has(spec.name)); }

  constructor(private readonly concurrency = 4) {}

  register(spec: ToolSpec): void {
    this.specs.set(spec.name, spec);
  }

  schemas(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return [...this.specs.values()].filter((spec) => !this.disabled.has(spec.name)).map((spec) => ({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    }));
  }

  async executeBatch(calls: ToolCall[], ctx: ToolRunContext): Promise<ToolResult[]> {
    if (calls.length > 1 && calls.some((call) => this.specs.get(call.name)?.terminal)) return calls.map(() => ({ status: "failed", summary: "结束任务必须单独调用，不能与其他工具并行；请先执行剩余操作再报告结果。", data: { failureKind: "validation" } }));
    const results: ToolResult[] = new Array(calls.length);
    const exclusive = calls.filter((call) => this.specs.get(call.name)?.exclusive);
    const parallel = calls.filter((call) => !this.specs.get(call.name)?.exclusive);
    const run = async (call: ToolCall, index: number) => {
      results[index] = await this.executeOne(call, ctx);
    };
    for (const [index, call] of calls.entries()) {
      if (exclusive.includes(call)) await run(call, index);
    }
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, Math.max(parallel.length, 0)) }, async () => {
      while (cursor < parallel.length) {
        const call = parallel[cursor]!;
        const index = calls.indexOf(call);
        cursor += 1;
        await run(call, index);
      }
    });
    await Promise.all(workers);
    return results;
  }

  private async executeOne(call: ToolCall, ctx: ToolRunContext): Promise<ToolResult> {
    const spec = this.specs.get(call.name);
    if (this.disabled.has(call.name)) return { status: "failed", summary: `本轮未启用 ${call.name}，请使用本轮可用工具。` };
    if (!spec) return { status: "failed", summary: `未知工具：${call.name}` };
    const required = spec.parameters.required as string[] | undefined;
    for (const name of required ?? []) if (call.arguments[name] === undefined) return { status: "failed", summary: `缺少必填参数：${name}` };
    let settled: Promise<unknown> = Promise.resolve();
    const execute = async (): Promise<ToolResult> => {
      if (ctx.signal.aborted) return { status: "failed", summary: `${call.name} 已取消` };
      const timeoutMs = spec.timeoutMs ?? 45_000;
      const controller = new AbortController();
      const cancel = () => controller.abort(ctx.signal.reason);
      ctx.signal.addEventListener("abort", cancel, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;
      try {
        const operation = Promise.resolve().then(() => spec.execute(call.arguments, { ...ctx, signal: controller.signal }));
        settled = operation.catch(() => {});
        return await Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            abortListener = () => reject(controller.signal.reason ?? new Error("aborted"));
            controller.signal.addEventListener("abort", abortListener, { once: true });
            timer = setTimeout(() => controller.abort(new TimeoutError("timeout")), timeoutMs);
          }),
        ]);
      } catch (error) {
        if (ctx.signal.aborted) return { status: "failed", summary: `${call.name} 已取消` };
        if (error instanceof TimeoutError) {
          return { status: "timeout", summary: `${call.name} 执行超时`, retryable: true };
        }
        return { status: "failed", summary: `${call.name} 执行失败：${error instanceof Error ? error.message : error}` };
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", cancel);
        if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      }
    };
    const resource = typeof spec.resourceKey === "function" ? spec.resourceKey(call.arguments) : spec.resourceKey;
    return resource ? await this.withLock(resource, execute, () => settled, ctx.signal) : await execute();
  }

  private async withLock(key: string, job: () => Promise<ToolResult>, settled: () => Promise<unknown>, signal: AbortSignal): Promise<ToolResult> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    try {
      const ready = await new Promise<boolean>((resolve) => {
        const cancel = () => { signal.removeEventListener("abort", cancel); resolve(false); };
        if (signal.aborted) return cancel();
        signal.addEventListener("abort", cancel, { once: true });
        void previous.then(() => { signal.removeEventListener("abort", cancel); resolve(!signal.aborted); });
      });
      if (!ready) return { status: "failed", summary: "等待工具资源时已取消" };
      return await job();
    } finally {
      // A timeout does not mean the underlying operation has stopped yet.
      void settled().finally(() => { release(); if (this.locks.get(key) === tail) this.locks.delete(key); });
    }
  }
}

class TimeoutError extends Error {}

import { createHash } from "node:crypto";
import type { SessionStore } from "./types.ts";

export interface ApprovalRequest { id: string; tool: string; command: string; target: string; digest: string; expiresAt: string }
export class ApprovalBroker {
  private pending = new Map<string, { request: ApprovalRequest; settle: (approved: boolean, actor?: string, reason?: string) => Promise<void> }>();
  constructor(private readonly session: SessionStore, private readonly publish: (event: any) => void) {}

  list(): ApprovalRequest[] { return [...this.pending.values()].map((item) => item.request); }

  async recover(): Promise<void> {
    const settled = new Set(this.session.events.filter((e) => e.type === "approval/resolved").map((e) => e.data.id));
    for (const event of [...this.session.events]) if (event.type === "approval/request" && !settled.has(event.data.id)) {
      this.publish(await this.session.append("approval/resolved", { id: event.data.id, approved: false, reason: "服务重启，旧审批失效；需重新确认具体命令" }));
    }
  }

  async request(tool: string, command: string, target: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const request: ApprovalRequest = { id, tool, command, target, digest: createHash("sha256").update(JSON.stringify({ tool, command, target })).digest("hex"), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); this.pending.delete(id); };
      const settle = async (approved: boolean, actor?: string, reason?: string) => {
        if (settled) return;
        settled = true; cleanup();
        try {
          const event = await this.session.append("approval/resolved", { id, digest: request.digest, approved: approved && !signal.aborted, actor, reason });
          this.publish(event); resolve(approved && !signal.aborted);
        } catch (error) { reject(error); throw error; }
      };
      const cancel = () => { void settle(false, undefined, "已取消").catch(() => {}); };
      const timer = setTimeout(() => { void settle(false, undefined, "审批超时").catch(() => {}); }, 5 * 60_000);
      signal.addEventListener("abort", cancel, { once: true });
      this.pending.set(id, { request, settle });
      void Promise.resolve(this.session.append("approval/request", request as unknown as Record<string, unknown>)).then((event) => {
        this.publish(event);
        if (signal.aborted) cancel();
      }).catch((error) => { settled = true; cleanup(); reject(error); });
    });
  }

  async answer(id: string, approved: boolean, actor: string): Promise<boolean> {
    const item = this.pending.get(id);
    if (!item) return false;
    await item.settle(approved, actor, approved ? "用户批准此命令一次" : "用户拒绝");
    return true;
  }
}

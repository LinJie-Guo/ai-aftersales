import type { InboxTarget, UserMessage } from "./types.ts";
import type { SessionEvent } from "../shared/index.ts";

export type InboxPlacement = "queued" | "steering";

export interface InboxRow {
  id: string;
  content: string;
  preview: string;
  placement: InboxPlacement;
  referenceKnowledge: boolean;
  modelName?: string;
}

function previewOf(message: UserMessage): string {
  const names = (message.attachments ?? []).map((item) => item.fileName).filter(Boolean);
  const line = [message.content.replace(/\s+/g, " ").trim(), names.length ? `附件 ${names.join("、")}` : ""]
    .filter(Boolean)
    .join(" · ");
  if (!line) return "附件";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export class Inbox {
  nextTurn: UserMessage[] = [];
  nextStep: UserMessage[] = [];

  constructor(events: SessionEvent[] = []) {
    for (const event of events) this.apply(event);
  }

  apply(event: SessionEvent): void {
    const data = event.data;
    if (event.type === "inbox/put") {
      const message = data.message as unknown as UserMessage;
      if (!message?.id || !["next-turn", "next-step"].includes(String(data.target))) throw new Error("持久化队列数据损坏");
      this.remove(message.id);
      (data.target === "next-turn" ? this.nextTurn : this.nextStep).push(message);
    } else if (event.type === "inbox/edit") {
      const current = this.messageAt(String(data.id));
      if (current) this.replace(current.id, { ...current, content: String(data.content) });
    } else if (event.type === "inbox/remove" || event.type === "inbox/claim") {
      for (const id of data.ids as string[] ?? []) this.remove(id);
    }
  }

  get hasPending(): boolean {
    return this.nextTurn.length > 0 || this.nextStep.length > 0;
  }

  snapshot(): InboxRow[] {
    return [
      ...this.nextTurn.map((message) => ({
        id: message.id,
        content: message.content,
        preview: previewOf(message),
        placement: "queued" as const,
        referenceKnowledge: message.referenceKnowledge === true,
        modelName: message.modelName,
      })),
      ...this.nextStep
        .filter((message) => message.source === "steer" || message.source === "human")
        .map((message) => ({
          id: message.id,
          content: message.content,
          preview: previewOf(message),
          placement: "steering" as const,
          referenceKnowledge: message.referenceKnowledge === true,
          modelName: message.modelName,
        })),
    ];
  }

  locate(messageId: string): { target: InboxTarget; index: number } | undefined {
    for (const target of ["next-turn", "next-step"] as const) {
      const list = target === "next-turn" ? this.nextTurn : this.nextStep;
      const index = list.findIndex((message) => message.id === messageId);
      if (index >= 0) return { target, index };
    }
    return undefined;
  }

  messageAt(messageId: string): UserMessage | undefined {
    const location = this.locate(messageId);
    if (!location) return undefined;
    const list = location.target === "next-turn" ? this.nextTurn : this.nextStep;
    return list[location.index];
  }

  replace(messageId: string, next: UserMessage): boolean {
    const location = this.locate(messageId);
    if (!location) return false;
    const list = location.target === "next-turn" ? this.nextTurn : this.nextStep;
    list.splice(location.index, 1, next);
    return true;
  }

  remove(messageId: string): boolean {
    const location = this.locate(messageId);
    if (!location) return false;
    const list = location.target === "next-turn" ? this.nextTurn : this.nextStep;
    list.splice(location.index, 1);
    return true;
  }

  splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[] {
    const list = target === "next-turn" ? this.nextTurn : this.nextStep;
    return list.splice(start, deleteCount, ...inserted);
  }

  claim(target: InboxTarget): UserMessage[] {
    const nextStep = this.nextStep.splice(0, this.nextStep.length);
    if (target !== "next-turn") return nextStep;
    const nextTurn = this.nextTurn.splice(0, 1);
    return [...nextStep, ...nextTurn];
  }

  clear(): void {
    this.nextTurn = [];
    this.nextStep = [];
  }

  dropInjected(): void {
    this.nextStep = this.nextStep.filter((message) => message.source !== "inject");
  }
}

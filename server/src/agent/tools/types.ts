export type ToolStatus = "success" | "failed" | "denied" | "timeout" | "unavailable";

export interface ToolResult {
  status: ToolStatus;
  summary: string;
  artifactId?: string;
  data?: Record<string, unknown>;
  retryable?: boolean;
  sessionEvents?: Array<{ type: string; data: Record<string, unknown> }>;
  completion?: { status: "completed" | "blocked" | "needs_input"; summary: string; evidenceIds: string[]; blockers: string[] };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolRunContext {
  signal: AbortSignal;
  inject: (content: string) => void;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  resourceKey?: string | ((args: Record<string, unknown>) => string | undefined);
  timeoutMs?: number;
  exclusive?: boolean;
  terminal?: boolean;
  execute: (args: Record<string, unknown>, ctx: ToolRunContext) => Promise<ToolResult>;
}

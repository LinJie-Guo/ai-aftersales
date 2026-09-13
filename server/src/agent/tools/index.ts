import { ArtifactStore } from "./artifacts.ts";
import { createCodeTools } from "./code.ts";
import { createKnowledgeTools, type KnowledgeHit } from "./knowledge.ts";
import { ToolRegistry } from "./registry.ts";
import { createSshEnvTools, type SshTarget } from "./ssh.ts";
import { createRemoteReadTools } from "./remote-read.ts";
import { createHttpTool } from "./http.ts";

export * from "./artifacts.ts";
export * from "./code.ts";
export * from "./knowledge.ts";
export * from "./registry.ts";
export * from "./ssh.ts";
export * from "./types.ts";

export type ToolGroup = "code" | "env" | "knowledge";

export interface ToolContext {
  reposDir: string;
  artifacts: ArtifactStore;
  customerId: string;
  workdir?: string;
  ssh: SshTarget | null;
  searchKnowledge: (query: string) => Promise<KnowledgeHit[]>;
  include?: ToolGroup[];
  approve?: (tool: string, command: string, signal: AbortSignal) => Promise<boolean>;
}

export function createToolRegistry(ctx: ToolContext): ToolRegistry {
  const registry = new ToolRegistry(4);
  const include = new Set<ToolGroup>(ctx.include ?? ["code", "env", "knowledge"]);
  if (include.size) registry.register(ctx.artifacts.readTool());
  if (include.has("code")) for (const spec of createCodeTools(ctx)) registry.register(spec);
  if (include.has("env")) {
    const remoteTools = createRemoteReadTools({ ...ctx, target: ctx.ssh });
    for (const spec of remoteTools) registry.register(spec);
    registry.register(createHttpTool({ ...ctx, target: ctx.ssh }));
    for (const spec of createSshEnvTools({ ...ctx, target: ctx.ssh, readOnly: remoteTools.find((tool) => tool.name === "remote_read")!.execute })) registry.register(spec);
  }
  if (include.has("knowledge")) for (const spec of createKnowledgeTools({ search: ctx.searchKnowledge, artifacts: ctx.artifacts })) registry.register(spec);
  return registry;
}

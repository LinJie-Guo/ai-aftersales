import { describe, expect, it } from "vitest";

import { ArtifactStore, createToolRegistry, ToolRegistry } from "../src/agent/tools/index.ts";

describe("default tools", () => {
  it("registers only code, ssh, and knowledge tools", () => {
    const registry = createToolRegistry({
      reposDir: "/tmp",
      artifacts: new ArtifactStore("/tmp"),
      customerId: "c1",
      ssh: null,
      searchKnowledge: async () => [],
    });
    expect(registry.schemas().map((tool) => tool.name).sort()).toEqual([
      "artifact_read",
      "bash",
      "code_git_log",
      "es_query",
      "glob",
      "grep",
      "http_request",
      "knowledge_search",
      "read",
      "remote_read",
    ]);
  });
});

describe("ToolRegistry duplicate calls", () => {
  it("executes consecutive identical calls instead of skipping them", async () => {
    const tools = new ToolRegistry();
    let gitRuns = 0;
    tools.register({
      name: "code_git_log",
      description: "log",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      async execute() {
        gitRuns += 1;
        return { status: "success", summary: "4525b0c merge" };
      },
    });
    const ctx = { signal: new AbortController().signal, inject() {} };
    const git = { name: "code_git_log", arguments: { path: "kb-api", limit: 1 } };
    expect((await tools.executeBatch([{ id: "1", ...git }], ctx))[0]?.status).toBe("success");
    expect((await tools.executeBatch([{ id: "2", ...git }], ctx))[0]?.status).toBe("success");
    expect(gitRuns).toBe(2);
  });
});

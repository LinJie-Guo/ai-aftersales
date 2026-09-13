import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/agent/tools/artifacts.ts";
import {
  buildGrepCommand,
  createCodeTools,
  formatGrepMatches,
  formatReadOutput,
  parseGlobArgs,
  parseGrepArgs,
  parseGrepMatches,
  parseReadArgs,
  resolveWorkspacePath,
} from "../src/agent/tools/code.ts";

describe("code tool parsers (harness-compatible)", () => {
  it("parses read args like harness", () => {
    expect(parseReadArgs({ file_path: "a.ts" })).toEqual({ filePath: "a.ts", offset: 1, limit: 2000 });
    expect(() => parseReadArgs({ file_path: "a.ts", offset: 0 })).toThrow(/正整数/);
    expect(() => parseReadArgs({ file_path: "a.ts", limit: 2001 })).toThrow(/2000/);
  });

  it("rejects invalid grep include filters", () => {
    expect(() => parseGrepArgs({ pattern: "foo", include: "!*.ts" })).toThrow(/否定/);
    expect(() => parseGrepArgs({ pattern: "foo", include: "*.ts,*.js" })).toThrow(/一个 glob/);
    expect(parseGrepArgs({ pattern: "foo", include: "*.{ts,js}" }).include).toBe("*.{ts,js}");
  });

  it("rejects empty glob pattern", () => {
    expect(() => parseGlobArgs({ pattern: "  " })).toThrow(/不能为空/);
  });

  it("keeps model values as argv, not a shell string", () => {
    expect(buildGrepCommand({ pattern: "a|b", path: "src", include: "*.java" })).toEqual([
      "--json",
      "--regexp=a|b",
      "--glob=*.java",
      "--",
      "src",
    ]);
  });

  it("parses rg --json matches and groups by file", () => {
    const stdout = [
      JSON.stringify({ type: "begin", data: { path: { text: "a.java" } } }),
      JSON.stringify({ type: "match", data: { path: { text: "a.java" }, line_number: 12, lines: { text: "indexName\n" } } }),
      JSON.stringify({ type: "match", data: { path: { text: "b.java" }, line_number: 3, lines: { text: "other" } } }),
    ].join("\n");
    const matches = parseGrepMatches(stdout);
    expect(matches).toEqual([
      { path: "a.java", lineNumber: 12, line: "indexName" },
      { path: "b.java", lineNumber: 3, line: "other" },
    ]);
    expect(formatGrepMatches(matches)).toContain("第 12 行: indexName");
  });

  it("formats a line-numbered read envelope", () => {
    const text = formatReadOutput("demo/A.java", {
      offset: 1,
      totalLines: 2,
      lines: [{ number: 1, text: "class A {}" }],
    });
    expect(text).toContain("<path>demo/A.java</path>");
    expect(text).toContain("1: class A {}");
    expect(text).toContain("使用 offset=2 继续");
  });

  it("rejects paths outside the workspace", () => {
    expect(() => resolveWorkspacePath("/tmp/ws", "../etc/passwd")).toThrow(/客户代码目录/);
  });
});

describe("code tools against a workspace", () => {
  it("read / grep / glob stay inside the pulled repos", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aftersale-code-"));
    const repo = path.join(root, "demo");
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", "App.java"), "class App {\n  String index = \"vuln\";\n}\n");
    await writeFile(path.join(repo, "README.md"), "# demo\n");
    const tools = Object.fromEntries(
      createCodeTools({ reposDir: root, artifacts: new ArtifactStore(path.join(root, "_art")) }).map((tool) => [tool.name, tool]),
    );

    const read = await tools.read.execute({ file_path: "demo/src/App.java", offset: 2, limit: 1 }, {} as never);
    expect(read.status).toBe("success");
    expect(read.summary).toContain("2:   String index");

    const grepped = await tools.grep.execute({ pattern: "index", include: "*.java" }, {} as never);
    expect(grepped.status).toBe("success");
    expect(grepped.summary).toMatch(/找到 1 处匹配/);
    expect(grepped.summary).toContain("demo/src/App.java");

    const globbed = await tools.glob.execute({ pattern: "*.java" }, {} as never);
    expect(globbed.status).toBe("success");
    expect(globbed.summary).toContain("demo/src/App.java");
    expect(globbed.summary).not.toContain("README.md");
  });
});

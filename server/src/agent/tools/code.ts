import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ToolSpec } from "./types.ts";

import type { ArtifactStore } from "./artifacts.ts";

const execFileAsync = promisify(execFile);

const READ_LIMIT = 2000;
const READ_MAX_LINE_LENGTH = 2000;
const GREP_MAX_MATCHES = 250;
const GREP_MAX_LINE_BYTES = 2000;
const GLOB_MAX_RESULTS = 100;
const GLOB_VCS_EXCLUDES = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"] as const;

export interface GrepMatch {
  path: string;
  lineNumber: number;
  line: string;
}

export function createCodeTools(input: { reposDir: string; artifacts: ArtifactStore }): ToolSpec[] {
  const { reposDir, artifacts } = input;

  async function persist(name: string, args: Record<string, unknown>, text: string) {
    const ref = await artifacts.persistText("code", text, { tool: name, arguments: args });
    return { status: "success" as const, summary: ref.preview, artifactId: ref.id };
  }

  function fail(error: unknown) {
    return { status: "failed" as const, summary: error instanceof Error ? error.message : String(error) };
  }

  return [
    {
      name: "read",
      description: "读取已拉取的本地客户源码，返回行号。file_path 从仓库名开始，例如 kb-api/src/...；不能读取客户服务器或容器内路径，远程文件请用 remote_read。",
      parameters: objectSchema({
        file_path: { type: "string", description: "Path to read, relative to the pulled customer code workspace." },
        offset: { type: "integer", description: "1-based first line to return. Defaults to 1." },
        limit: { type: "integer", description: `Maximum number of lines to return. Defaults to ${READ_LIMIT}.` },
      }, ["file_path"]),
      timeoutMs: 15_000,
      async execute(args, ctx) {
        try {
          requireWorkspace(reposDir);
          const parsed = parseReadArgs({
            file_path: str(args.file_path),
            offset: numOpt(args.offset),
            limit: numOpt(args.limit),
          });
          const abs = resolveWorkspacePath(reposDir, parsed.filePath);
          const display = toWorkspaceRelative(abs, reposDir);
          const info = await stat(abs);
          if (info.size > 8 * 1024 * 1024) throw new Error("文件超过 8MB，请使用 grep 定位内容");
          const text = await readFile(abs, { encoding: "utf8", signal: ctx.signal });
          if (text.includes("\0")) throw new Error(`${display} 不是 UTF-8 文本文件`);
          return persist("read", args, formatReadOutput(display, buildReadWindow(text, parsed.offset, parsed.limit)));
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      name: "grep",
      description: `在已拉取的本地源码仓中用 ripgrep 搜索，默认覆盖全部仓库。返回前 ${GREP_MAX_MATCHES} 个匹配及行号。不是远程文件搜索；先在这里定位源码，不要先反编译部署包。`,
      parameters: objectSchema({
        pattern: { type: "string", description: "Regular expression to search for (ripgrep syntax)." },
        path: { type: "string", description: "File or directory to search. Defaults to the pulled customer code workspace." },
        include: { type: "string", description: "One glob filter for which files to search (e.g. \"*.ts\", \"*.{js,jsx}\"). Not a list; negation is not supported." },
      }, ["pattern"]),
      timeoutMs: 30_000,
      async execute(args, ctx) {
        try {
          requireWorkspace(reposDir);
          const inputArgs = parseGrepArgs({
            pattern: str(args.pattern),
            path: emptyToUndef(str(args.path)),
            include: emptyToUndef(str(args.include)),
          });
          const target = resolveWorkspacePath(reposDir, inputArgs.path);
          const run = await runRipgrep(buildGrepCommand({ ...inputArgs, path: target }), reposDir, ctx.signal);
          if (run.noMatches) return persist("grep", args, "未找到匹配");
          const matches = parseGrepMatches(run.stdout).map((match) => ({
            ...match,
            path: toWorkspaceRelative(match.path, reposDir),
            line: previewLine(match.line, GREP_MAX_LINE_BYTES),
          }));
          const kept = matches.slice(0, GREP_MAX_MATCHES);
          const header = matches.length > GREP_MAX_MATCHES
            ? `找到 ${kept.length} / ${matches.length} 处匹配`
            : `找到 ${matches.length} 处匹配`;
          const body = formatGrepMatches(kept);
          const footer = matches.length > GREP_MAX_MATCHES
            ? "\n\n（缩小 pattern、path 或 include 可查看更多）"
            : "";
          return persist("grep", args, `${header}\n\n${body}${footer}`);
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      name: "glob",
      description:
        "Find files whose paths match a glob pattern. Returns matching file paths — never directories — "
        + "including hidden and ignored files (VCS metadata directories are excluded). "
        + `Up to ${GLOB_MAX_RESULTS} paths come back in modification-time order. This tool does not enumerate directory entries.`,
      parameters: objectSchema({
        pattern: {
          type: "string",
          description:
            "Glob pattern to match file paths against (e.g. \"**/*.ts\", \"src/**/*.test.js\"). "
            + "A pattern with no \"/\" matches the basename at any depth, so \"*\" and \"*.ts\" both search the whole tree.",
        },
        path: { type: "string", description: "Directory to search in. Defaults to the pulled customer code workspace." },
      }, ["pattern"]),
      timeoutMs: 30_000,
      async execute(args, ctx) {
        try {
          requireWorkspace(reposDir);
          const inputArgs = parseGlobArgs({
            pattern: str(args.pattern),
            path: emptyToUndef(str(args.path)),
          });
          const target = resolveWorkspacePath(reposDir, inputArgs.path);
          const run = await runRipgrep(buildGlobCommand({ ...inputArgs, path: target }), reposDir, ctx.signal);
          if (run.noMatches) return persist("glob", args, "未找到文件");
          const paths = run.stdout
            .split("\n")
            .filter(Boolean)
            .map((line) => toWorkspaceRelative(line, reposDir));
          if (paths.length <= GLOB_MAX_RESULTS) return persist("glob", args, paths.join("\n"));
          return persist(
            "glob",
            args,
            `${paths.slice(0, GLOB_MAX_RESULTS).join("\n")}\n\n（仅显示 ${GLOB_MAX_RESULTS} / ${paths.length} 条路径。缩小 pattern 或 path 可查看更多。）`,
          );
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      name: "code_git_log",
      description: "读取已拉取仓库的只读提交历史。",
      parameters: objectSchema({
        path: { type: "string", description: "仓库名或仓库内路径。" },
        limit: { type: "integer", description: "最多返回多少条，默认 20。" },
      }, ["path"]),
      timeoutMs: 20_000,
      async execute(args, ctx) {
        try {
          requireWorkspace(reposDir);
          return persist("code_git_log", args, await gitLog(reposDir, str(args.path), num(args.limit, 20), ctx.signal));
        } catch (error) {
          return fail(error);
        }
      },
    },
  ];
}

export function parseReadArgs(args: { file_path: string; offset?: number; limit?: number }) {
  if (!args.file_path.trim()) throw new Error("file_path 不能为空");
  const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, "offset");
  const limit = args.limit === undefined ? READ_LIMIT : parsePositiveInteger(args.limit, "limit");
  if (limit > READ_LIMIT) throw new Error(`limit 不能超过 ${READ_LIMIT}`);
  return { filePath: args.file_path, offset, limit };
}

export function parseGrepArgs(args: { pattern: string; path?: string; include?: string }) {
  if (args.pattern.length === 0) throw new Error("pattern 不能为空");
  if (args.path !== undefined && args.path.trim().length === 0) throw new Error("path 不能为空");
  if (args.include !== undefined) validateInclude(args.include);
  return {
    pattern: args.pattern,
    ...args.path !== undefined ? { path: args.path } : {},
    ...args.include !== undefined ? { include: args.include } : {},
  };
}

export function parseGlobArgs(args: { pattern: string; path?: string }) {
  if (args.pattern.trim().length === 0) throw new Error("pattern 不能为空");
  if (args.path !== undefined && args.path.trim().length === 0) throw new Error("path 不能为空");
  return { pattern: args.pattern, ...args.path !== undefined ? { path: args.path } : {} };
}

export function validateInclude(include: string) {
  if (include.trim().length === 0) throw new Error("include 不能为空");
  if (include.startsWith("!")) throw new Error("include 不支持以 ! 开头的否定模式");
  let braceDepth = 0;
  for (const char of include) {
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (char === "," && braceDepth === 0) {
      throw new Error("include 只能是一个 glob，多个请用 {a,b}");
    }
  }
}

export function buildGrepCommand(input: { pattern: string; path?: string; include?: string }): string[] {
  const parts = ["--json", `--regexp=${input.pattern}`];
  if (input.include !== undefined) parts.push(`--glob=${input.include}`);
  if (input.path !== undefined) parts.push("--", input.path);
  return parts;
}

export function buildGlobCommand(input: { pattern: string; path?: string }): string[] {
  return [
    "--files",
    `--glob=${input.pattern}`,
    "--sort=modified",
    "--no-ignore",
    "--hidden",
    ...GLOB_VCS_EXCLUDES.flatMap((name) => [`--glob=!**/${name}`, `--glob=!**/${name}/**`]),
    ...input.path !== undefined ? ["--", input.path] : [],
  ];
}

export function parseGrepMatches(stdout: string): GrepMatch[] {
  const matches: GrepMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const match = parseGrepRecord(line);
    if (match) matches.push(match);
  }
  return matches;
}

export function formatGrepMatches(matches: GrepMatch[]): string {
  const byFile = new Map<string, GrepMatch[]>();
  for (const match of matches) {
    const group = byFile.get(match.path);
    if (group) group.push(match);
    else byFile.set(match.path, [match]);
  }
  return [...byFile.entries()]
    .map(([file, group]) => `${file}\n${group.map((item) => `第 ${item.lineNumber} 行: ${item.line}`).join("\n")}`)
    .join("\n\n");
}

export function formatReadOutput(displayPath: string, outcome: { offset: number; lines: Array<{ number: number; text: string }>; totalLines: number }) {
  const endLine = outcome.lines.at(-1)?.number ?? Math.max(0, outcome.offset - 1);
  const footer = endLine < outcome.totalLines
    ? `（显示第 ${outcome.offset}-${endLine} 行，共 ${outcome.totalLines} 行。使用 offset=${endLine + 1} 继续。）`
    : `（已到文件末尾，共 ${outcome.totalLines} 行）`;
  const body = outcome.lines.length
    ? `${outcome.lines.map((line) => `${line.number}: ${line.text}`).join("\n")}\n\n${footer}`
    : footer;
  return `<path>${displayPath}</path>\n<type>file</type>\n<content>\n${body}\n</content>`;
}

export function resolveWorkspacePath(reposDir: string, rel?: string): string {
  const root = path.resolve(reposDir);
  if (!rel) return root;
  const target = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(root, rel);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("path 必须在已拉取的客户代码目录内。read/grep/glob 是本地源码工具，请使用仓库相对路径（如 kb-api/src/...），或不传 path 搜索全部源码。客户服务器 /tmp 等路径请用 remote_read 读取，不要混用两个文件空间。");
  }
  if (existsSync(target)) {
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) throw new Error("符号链接超出客户代码目录");
  }
  return target;
}

export function toWorkspaceRelative(absPath: string, reposDir: string): string {
  const root = path.resolve(reposDir);
  const abs = path.isAbsolute(absPath) ? path.resolve(absPath) : path.resolve(root, absPath);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..")) return abs;
  return rel;
}

function buildReadWindow(text: string, offset: number, limit: number) {
  const all = text.split(/\r?\n/);
  if (text.endsWith("\n")) all.pop();
  const totalLines = all.length;
  if (offset > totalLines && !(totalLines === 0 && offset === 1)) {
    throw new Error(`offset ${offset} 超出范围（共 ${totalLines} 行）`);
  }
  const start = offset - 1;
  const lines = all.slice(start, start + limit).map((line, index) => ({
    number: offset + index,
    text: line.length > READ_MAX_LINE_LENGTH
      ? `${line.slice(0, READ_MAX_LINE_LENGTH)}...（行已截断到 ${READ_MAX_LINE_LENGTH} 字符）`
      : line,
  }));
  return { offset, lines, totalLines };
}

function parseGrepRecord(line: string): GrepMatch | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("grep 输出解析失败");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("grep 输出解析失败");
  const record = parsed as { type?: unknown; data?: unknown };
  if (record.type !== "match") return undefined;
  if (typeof record.data !== "object" || record.data === null) throw new Error("grep 输出解析失败");
  const data = record.data as { path?: { text?: unknown }; line_number?: unknown; lines?: { text?: unknown; bytes?: unknown } };
  if (typeof data.path?.text !== "string" || typeof data.line_number !== "number") {
    throw new Error("grep 输出解析失败");
  }
  if (typeof data.lines?.text === "string") {
    return { path: data.path.text, lineNumber: data.line_number, line: data.lines.text.replace(/\r?\n$/, "") };
  }
  if (typeof data.lines?.bytes === "string") {
    return { path: data.path.text, lineNumber: data.line_number, line: "（该行不是有效 UTF-8）" };
  }
  throw new Error("grep 输出解析失败");
}

async function runRipgrep(argv: string[], cwd: string, signal?: AbortSignal): Promise<{ stdout: string; noMatches: boolean }> {
  try {
    const { stdout } = await execFileAsync("rg", ["--no-config", ...argv], {
      cwd,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      signal,
    });
    return { stdout, noMatches: false };
  } catch (error: any) {
    if (error?.code === 1) return { stdout: String(error.stdout ?? ""), noMatches: true };
    if (error?.code === "ENOENT") throw new Error("本机未安装 ripgrep (rg)，无法搜索代码");
    const stderr = String(error?.stderr ?? error?.message ?? error);
    if (/regex parse error|error parsing glob/i.test(stderr)) {
      throw new Error(`pattern 被 ripgrep 拒绝：${stderr.trim()}`);
    }
    throw new Error(`搜索失败：${stderr.trim()}`);
  }
}

async function gitLog(reposDir: string, rel: string, limit: number, signal?: AbortSignal): Promise<string> {
  const target = resolveWorkspacePath(reposDir, rel);
  const cwd = await findGitRoot(target, path.resolve(reposDir));
  const { stdout } = await execFileAsync("git", ["log", `--max-count=${Math.max(1, Math.min(limit, 50))}`, "--oneline"], {
    cwd,
    timeout: 15_000,
    signal,
  });
  return stdout.trim() || "(无提交)";
}

async function findGitRoot(start: string, root: string): Promise<string> {
  let current = start;
  while (current.startsWith(root)) {
    try {
      const info = await stat(path.join(current, ".git"));
      if (info.isDirectory() || info.isFile()) return current;
    } catch {
      /* keep walking */
    }
    if (current === root) break;
    current = path.dirname(current);
  }
  throw new Error(`未找到 git 仓库：${toWorkspaceRelative(start, root)}`);
}

function requireWorkspace(reposDir: string) {
  if (!existsSync(reposDir)) throw new Error(`代码目录不存在：${reposDir}。请先在客户信息里拉取代码。`);
}

function previewLine(line: string, maxBytes: number): string {
  if (Buffer.byteLength(line, "utf8") <= maxBytes) return line;
  let end = line.length;
  while (end > 0 && Buffer.byteLength(line.slice(0, end), "utf8") > maxBytes) end -= 1;
  return `${line.slice(0, end)}（行已截断）`;
}

function parsePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function numOpt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function emptyToUndef(value: string): string | undefined {
  return value ? value : undefined;
}

export { READ_LIMIT };

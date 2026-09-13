export type GrepFile = { path: string; lines: { n: string; text: string }[] };

const TITLES: Record<string, string> = {
  grep: "搜索代码",
  glob: "查找文件",
  read: "读取文件",
  bash: "终端",
  knowledge_search: "检索知识",
  code_git_log: "提交历史",
  artifact_read: "读取结果",
  remote_read: "读取现场",
  http_request: "HTTP 请求",
  es_query: "查询 ES",
  finish_task: "本轮结果",
  investigation_state: "记录进展",
};

export function toolTitle(name?: string) {
  const key = (name || "").trim();
  return TITLES[key] || key || "工具";
}

export function toolHeadline(name: string, summary?: string, args?: Record<string, unknown>) {
  const text = (summary || "").trim();
  if (name === "grep") {
    const pattern = str(args?.pattern);
    const count = text.match(/找到\s+([\d /]+)\s*处匹配/)?.[1];
    const firstFile = parseGrepCard(text)?.files[0]?.path;
    const subject = pattern || (firstFile ? firstFile.split("/").filter(Boolean).slice(-2).join("/") : "");
    if (text.startsWith("未找到")) return subject ? `${subject}  无匹配` : "无匹配";
    if (count) return subject ? `${subject}  ${count} 处` : `${count} 处`;
    return subject || "搜索";
  }
  if (name === "glob") {
    const pattern = str(args?.pattern);
    if (text.startsWith("未找到")) return pattern ? `${pattern} · 无文件` : "无文件";
    const n = text.split("\n").filter((line) => line.trim() && !line.startsWith("（")).length;
    return pattern ? `${pattern} · ${n} 个文件` : `${n} 个文件`;
  }
  if (name === "read") {
    const path = str(args?.file_path) || str(args?.path) || text.match(/<path>([^<]+)<\/path>/)?.[1] || "";
    return path.split("/").filter(Boolean).slice(-2).join("/") || "读取文件";
  }
  if (name === "bash") {
    return str(args?.description) || shortCommand(str(args?.command)) || "命令已完成";
  }
  if (name === "knowledge_search") {
    const query = str(args?.query);
    if (/未搜索到|未检索到|未找到/.test(text)) return query ? `${query}  无命中` : "无命中";
    return query || "已检索";
  }
  if (!text) return "完成";
  const first = text.split("\n").map((line) => line.trim()).find(Boolean) || text;
  return first.length > 72 ? `${first.slice(0, 72)}…` : first;
}

export function parseGrepCard(summary?: string): { header: string; files: GrepFile[] } | null {
  const text = (summary || "").trim();
  if (!text) return null;
  const lines = text.split("\n");
  const header = lines[0] || "";
  if (!/^找到 |^未找到/.test(header) && !/第 \d+ 行:/.test(text)) return null;
  const files: GrepFile[] = [];
  let current: GrepFile | null = null;
  for (const line of lines.slice(1)) {
    const hit = line.match(/^第\s+(\d+)\s+行:\s?(.*)$/);
    if (hit) {
      if (!current) current = { path: "（未知文件）", lines: [] };
      current.lines.push({ n: hit[1], text: hit[2] });
      continue;
    }
    if (!line.trim() || line.startsWith("（")) continue;
    if (current) files.push(current);
    current = { path: line.trim(), lines: [] };
  }
  if (current) files.push(current);
  return { header, files };
}

export function parseGlobCard(summary?: string): string[] | null {
  const text = (summary || "").trim();
  if (!text || text.startsWith("未找到")) return null;
  const paths = text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("（"));
  return paths.length ? paths : null;
}

function str(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function shortCommand(command: string) {
  if (!command) return "";
  const one = command.replace(/\s+/g, " ");
  return one.length > 56 ? `${one.slice(0, 56)}…` : one;
}

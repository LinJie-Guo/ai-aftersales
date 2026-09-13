import { mkdir, readFile, unlink, writeFile, stat } from "node:fs/promises";
import path from "node:path";

import { desc, eq, isNull, and, or, ilike, inArray, sql } from "drizzle-orm";

import { config } from "../config.ts";
import { db } from "../db/client.ts";
import { knowledge } from "../db/schema.ts";
import { knowledgeKeys, knowledgeScore } from "./ranking.ts";

export interface KnowledgeDocHit {
  id: string;
  title: string;
  summary: string;
  markdown: string;
}

const REL_DIR = "_knowledge";
const documentCache = new Map<string, { stamp: string; text: string }>();

export function knowledgeRoot() {
  return path.join(config.dataRoot, REL_DIR);
}

export function toRelDocPath(id: string) {
  return `${REL_DIR}/${id}.md`;
}

export async function writeKnowledgeDoc(id: string, markdown: string): Promise<string> {
  await mkdir(knowledgeRoot(), { recursive: true });
  const rel = toRelDocPath(id);
  await writeFile(path.join(config.dataRoot, rel), markdown, "utf8");
  documentCache.delete(rel);
  await db.update(knowledge).set({ searchText: markdown }).where(eq(knowledge.id, id));
  return rel;
}

export async function backfillKnowledgeSearch() {
  const rows = await db.select().from(knowledge).where(isNull(knowledge.searchText));
  for (const row of rows) {
    const markdown = await readKnowledgeDoc(row.docPath);
    await db.update(knowledge).set({ searchText: markdown || legacyMarkdown(row) }).where(eq(knowledge.id, row.id));
  }
}

export async function readKnowledgeDoc(relPath?: string | null): Promise<string> {
  const rel = String(relPath || "").trim();
  if (!rel || rel.includes("..") || !rel.startsWith(`${REL_DIR}/`)) return "";
  try {
    const file = path.join(config.dataRoot, rel);
    const info = await stat(file);
    const stamp = `${info.mtimeMs}:${info.size}`;
    const cached = documentCache.get(rel);
    if (cached?.stamp === stamp) return cached.text;
    const text = await readFile(file, "utf8");
    if (documentCache.size >= 128) documentCache.delete(documentCache.keys().next().value!);
    documentCache.set(rel, { stamp, text });
    return text;
  } catch {
    return "";
  }
}

export function stripMarkdown(text: string) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/-{3,}/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function clipText(text: string, max = 180) {
  const one = stripMarkdown(text);
  if (!one) return "";
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

export async function removeKnowledgeDoc(relPath?: string | null) {
  const rel = String(relPath || "").trim();
  if (!rel || rel.includes("..") || !rel.startsWith(`${REL_DIR}/`)) return;
  await unlink(path.join(config.dataRoot, rel)).catch(() => undefined);
}

export function buildKnowledgeMarkdown(input: {
  title: string;
  code?: string;
  customerName?: string;
  projectName?: string;
  summary: string;
  conclusion?: string;
  messages: Array<{ role: string; content: string }>;
}) {
  const lines = [
    `# ${input.title}`,
    "",
    input.code ? `- 工单：${input.code}` : "",
    input.customerName ? `- 客户：${input.customerName}` : "",
    input.projectName ? `- 项目：${input.projectName}` : "",
    `- 沉淀时间：${new Date().toISOString().slice(0, 19).replace("T", " ")}`,
    "",
    "## 问题摘要",
    "",
    input.summary || input.title,
    "",
  ].filter((line) => line !== "");

  if (input.conclusion?.trim()) {
    lines.push("## 结论", "", input.conclusion.trim(), "");
  }

  const dialogue = input.messages
    .map((item) => ({ role: item.role, content: String(item.content || "").trim() }))
    .filter((item) => item.content);
  if (dialogue.length) {
    lines.push("## 排查过程", "");
    for (const item of dialogue) {
      const who = item.role === "user" ? "售后" : "排查助手";
      lines.push(`### ${who}`, "", item.content, "");
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

export function legacyMarkdown(row: {
  title: string;
  symptom?: string | null;
  rootCause?: string | null;
  steps?: string | null;
  summary?: string | null;
}) {
  return [
    `# ${row.title}`,
    "",
    row.summary || row.symptom || "",
    "",
    row.rootCause ? `## 结论\n\n${row.rootCause}` : "",
    row.steps ? `## 处理步骤\n\n${row.steps}` : "",
  ].filter(Boolean).join("\n").trim() + "\n";
}

export async function searchKnowledgeDocs(query: string, limit = 8, visibleCustomerIds: string[] | null = null): Promise<KnowledgeDocHit[]> {
  const raw = String(query || "").trim();
  if (!raw) return [];
  const keys = knowledgeKeys(raw);
  if (!keys.length) return [];
  const searchable = sql<string>`coalesce(${knowledge.title}, '') || ' ' || coalesce(${knowledge.summary}, '') || ' ' || coalesce(${knowledge.rootCause}, '') || ' ' || coalesce(${knowledge.symptom}, '') || ' ' || coalesce(${knowledge.steps}, '') || ' ' || coalesce(${knowledge.searchText}, '')`;
  const scope = visibleCustomerIds === null ? undefined : visibleCustomerIds.length ? or(isNull(knowledge.customerId), inArray(knowledge.customerId, visibleCustomerIds)) : isNull(knowledge.customerId);
  const rows = await db.select().from(knowledge).where(and(isNull(knowledge.deletedAt), scope, or(...keys.map((key) => ilike(searchable, `%${key.replace(/[\\%_]/g, "\\$&")}%`))))).orderBy(desc(knowledge.createdAt)).limit(Math.max(32, limit * 8));
  const hits: Array<KnowledgeDocHit & { score: number }> = [];
  for (const row of rows) {
    if (visibleCustomerIds && row.customerId && !visibleCustomerIds.includes(row.customerId)) continue;
    const markdown = (await readKnowledgeDoc(row.docPath))
      || legacyMarkdown({
        title: row.title,
        symptom: row.symptom,
        rootCause: row.rootCause,
        steps: row.steps,
        summary: row.summary,
      });
    const summary = row.summary || clipText(row.rootCause || row.symptom || markdown, 180);
    const score = knowledgeScore(keys, row.title, summary, markdown);
    if (score > 0) hits.push({ id: row.id, title: row.title, summary, markdown, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score: _s, ...hit }) => hit);
}

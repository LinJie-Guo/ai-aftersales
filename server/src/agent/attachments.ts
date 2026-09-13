import { readFile, stat, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import { unzipSync } from "fflate";

import { config } from "../config.ts";

import type { ChatMessage, MessageAttachment, UserMessage } from "./types.ts";

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_CHARS = 80_000;
export const MAX_ATTACHMENTS = 10;
const MAX_EXPANDED_BYTES = 48 * 1024 * 1024;
const parsedCache = new Map<string, { stamp: string; result: { text?: string; image?: { mimeType: string; dataUrl: string }; reason?: string } }>();
const execFileAsync = promisify(execFile);

export function clearAttachmentCache() { parsedCache.clear(); }

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".log": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".xml": "application/xml",
  ".yml": "text/yaml",
  ".yaml": "text/yaml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/plain",
  ".java": "text/plain",
  ".py": "text/plain",
  ".sql": "text/plain",
  ".sh": "text/x-shellscript",
  ".conf": "text/plain",
  ".ini": "text/plain",
  ".properties": "text/plain",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const TEXT_EXT = new Set([
  ".txt", ".md", ".log", ".json", ".csv", ".tsv", ".xml", ".yml", ".yaml",
  ".html", ".htm", ".css", ".js", ".ts", ".java", ".py", ".sql", ".sh",
  ".conf", ".ini", ".properties", ".svg",
]);

const FILE_MARKDOWN = /!?\[([^\]]*)\]\((\/api\/v1\/files\/([^)\s]+))\)/g;

export type AttachmentKind = "image" | "text" | "office" | "pdf" | "binary";

export function guessMime(fileName: string, fallback = "application/octet-stream"): string {
  return MIME_BY_EXT[path.extname(fileName).toLowerCase()] || fallback || "application/octet-stream";
}

export function isImageMime(mime: string, fileName = ""): boolean {
  return mime.startsWith("image/") || MIME_BY_EXT[path.extname(fileName).toLowerCase()]?.startsWith("image/") === true;
}

export function storedNameOf(input: { storedName?: unknown; stored_name?: unknown; viewUrl?: unknown; view_url?: unknown }): string {
  const direct = String(input.storedName || input.stored_name || "").trim();
  if (isSafeStoredName(direct)) return direct;
  const url = String(input.viewUrl || input.view_url || "");
  const match = url.match(/\/api\/v1\/files\/([^/?#]+)/);
  const fromUrl = match?.[1] ? decodeURIComponent(match[1]) : "";
  return isSafeStoredName(fromUrl) ? fromUrl : "";
}

export function isSafeStoredName(name: string): boolean {
  return Boolean(name) && !name.includes("..") && !name.includes("/") && !name.includes("\\");
}

export function attachmentsFromRequest(raw: unknown): MessageAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: MessageAttachment[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const storedName = storedNameOf(rec);
    if (!storedName || seen.has(storedName)) continue;
    seen.add(storedName);
    const fileName = String(rec.fileName || rec.file_name || storedName);
    const mimeType = String(rec.mimeType || rec.mime_type || "") || guessMime(fileName);
    out.push({
      fileName,
      storedName,
      mimeType,
      viewUrl: String(rec.viewUrl || rec.view_url || `/api/v1/files/${storedName}`),
    });
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}

export function attachmentsFromMarkdown(content: string): MessageAttachment[] {
  const out: MessageAttachment[] = [];
  const seen = new Set<string>();
  const re = new RegExp(FILE_MARKDOWN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) {
    const fileName = String(match[1] || "").trim() || "附件";
    const storedName = decodeURIComponent(String(match[3] || ""));
    if (!isSafeStoredName(storedName) || seen.has(storedName)) continue;
    seen.add(storedName);
    out.push({
      fileName,
      storedName,
      mimeType: guessMime(fileName),
      viewUrl: `/api/v1/files/${storedName}`,
    });
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}

export function classifyAttachment(fileName: string, mimeType = ""): AttachmentKind {
  const ext = path.extname(fileName).toLowerCase();
  const mime = mimeType || guessMime(fileName);
  if (isImageMime(mime, fileName) && ext !== ".svg") return "image";
  if (ext === ".pdf" || mime === "application/pdf") return "pdf";
  if ([".docx", ".xlsx", ".pptx"].includes(ext)) return "office";
  if (TEXT_EXT.has(ext) || mime.startsWith("text/") || mime === "application/json" || mime === "application/xml") {
    return "text";
  }
  return "binary";
}

export function mergeAttachments(...groups: Array<MessageAttachment[] | undefined>): MessageAttachment[] {
  const out: MessageAttachment[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const item of group ?? []) {
      if (!item.storedName || seen.has(item.storedName)) continue;
      seen.add(item.storedName);
      out.push(item);
      if (out.length >= MAX_ATTACHMENTS) return out;
    }
  }
  return out;
}

export function uploadPath(storedName: string, root = config.dataRoot): string {
  return path.join(root, "_uploads", storedName);
}

export async function hydrateChatMessages(
  messages: ChatMessage[],
  root = config.dataRoot,
): Promise<ChatMessage[]> {
  return Promise.all(messages.map((message) => (
    message.role === "user" ? hydrateUserMessage(message, root) : message
  )));
}

export async function hydrateUserMessage(message: UserMessage, root = config.dataRoot): Promise<UserMessage> {
  const attachments = mergeAttachments(message.attachments, attachmentsFromMarkdown(message.content));
  const images = [...(message.images ?? [])];
  const blocks: string[] = [];
  for (const attachment of attachments) {
    const kind = classifyAttachment(attachment.fileName, attachment.mimeType);
    if (message.hydrated && (kind !== "image" || message.images?.length)) continue;
    try {
      const file = uploadPath(attachment.storedName, root);
      const info = await stat(file);
      if (info.size > MAX_UPLOAD_BYTES) throw new Error("附件过大");
      const stamp = `${info.mtimeMs}:${info.size}:${attachment.fileName}:${attachment.mimeType}`;
      const cached = parsedCache.get(file);
      if (cached?.stamp === stamp) {
        if (cached.result.image) images.push(cached.result.image);
        else blocks.push(`--- 附件: ${attachment.fileName} ---\n${cached.result.text ?? cached.result.reason}`);
        continue;
      }
      const buf = await readFile(file);
      if (kind === "image") {
        if (buf.length > MAX_IMAGE_BYTES) {
          blocks.push(`【附件 ${attachment.fileName}】图片过大（${formatBytes(buf.length)}），未送入模型。`);
          continue;
        }
        const mime = attachment.mimeType.startsWith("image/") ? attachment.mimeType : guessMime(attachment.fileName, "image/png");
        const image = { mimeType: mime, dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
        images.push(image);
        cache(file, stamp, { image });
        continue;
      }
      const extracted = await extractDocumentText(buf, attachment.fileName, attachment.mimeType);
      if (extracted.ok) {
        blocks.push(`--- 附件: ${attachment.fileName} ---\n${clipExtracted(extracted.text)}`);
        cache(file, stamp, { text: clipExtracted(extracted.text) });
      } else {
        blocks.push(`【附件 ${attachment.fileName}】${extracted.reason}`);
      }
    } catch (error) {
      blocks.push(`【附件 ${attachment.fileName}】无法读取：${error instanceof Error ? error.message : "解析失败"}`);
    }
  }
  let content = stripFileMarkdown(message.content).trim();
  if (blocks.length) content = [content, ...blocks].filter(Boolean).join("\n\n");
  if (!content && (images.length || attachments.length)) content = "请查看附件。";
  return {
    ...message,
    content,
    attachments,
    hydrated: true,
    images: images.length ? images : undefined,
  };
}

function cache(file: string, stamp: string, result: { text?: string; image?: { mimeType: string; dataUrl: string }; reason?: string }) {
  // Bound base64 memory; cached originals remain immutable and permission checks run separately.
  if (parsedCache.size >= 8) parsedCache.delete(parsedCache.keys().next().value!);
  parsedCache.set(file, { stamp, result });
}

export async function extractDocumentText(
  buf: Buffer,
  fileName: string,
  mimeType = "",
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const kind = classifyAttachment(fileName, mimeType);
  if (kind === "text") {
    const text = decodeText(buf);
    if (!text.trim()) return { ok: false, reason: "文件是空的。" };
    return { ok: true, text };
  }
  if (kind === "pdf") {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aftersale-pdf-"));
    let text = "";
    try {
      const source = path.join(dir, "source.pdf");
      await writeFile(source, buf);
      const result = await execFileAsync("pdftotext", ["-layout", "-enc", "UTF-8", source, "-"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
      text = result.stdout;
    } catch { return { ok: false, reason: "PDF 解析失败或为扫描件，请提供截图，或启用 OCR 后重试。" }; }
    finally { await rm(dir, { recursive: true, force: true }); }
    if (!text.trim()) return { ok: false, reason: "PDF 未能提取文本（可能是扫描件或加密文档）。" };
    return { ok: true, text };
  }
  if (kind === "office") {
    const ext = path.extname(fileName).toLowerCase();
    const text = ext === ".xlsx"
      ? await extractXlsxText(buf)
      : ext === ".pptx"
        ? extractPptxText(buf)
        : extractDocxText(buf);
    if (!text.trim()) return { ok: false, reason: "Office 文档未能提取文本。" };
    return { ok: true, text };
  }
  return { ok: false, reason: "该格式无法直接阅读，请改传文本、截图、PDF 或 docx/xlsx。" };
}

export function extractDocxText(buf: Buffer): string {
  return xmlToText(unzipText(buf, "word/document.xml") || "");
}

export async function extractXlsxText(buf: Buffer): Promise<string> {
  checkedUnzip(buf);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const out: string[] = [];
  let length = 0;
  for (const sheet of workbook.worksheets) {
    out.push(`工作表：${sheet.name}`);
    sheet.eachRow((row, rowNumber) => {
      if (length > MAX_TEXT_CHARS) return;
      const cells: string[] = [];
      row.eachCell((cell) => { cells.push(`${cell.address}=${cell.formula ? `公式(${cell.formula}) 结果=${String(cell.result ?? "未缓存")}` : cell.text}`); });
      const line = `${rowNumber}: ${cells.join(" | ")}`;
      out.push(line); length += line.length;
    });
  }
  return out.join("\n");
}

export function extractPptxText(buf: Buffer): string {
  const names = zipEntryNames(buf).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return names.map((name, index) => {
    const body = xmlToText(unzipText(buf, name) || "");
    return body.trim() ? `幻灯片 ${index + 1}\n${body.trim()}` : "";
  }).filter(Boolean).join("\n\n");
}

export function unzipEntry(buf: Buffer, name: string): Buffer | null {
  const entry = checkedUnzip(buf)[name];
  return entry ? Buffer.from(entry) : null;
}

export function zipEntryNames(buf: Buffer): string[] {
  return Object.keys(checkedUnzip(buf));
}

function checkedUnzip(buf: Buffer) {
  let total = 0;
  return unzipSync(buf, { filter: (entry) => {
    total += entry.originalSize;
    if (total > MAX_EXPANDED_BYTES || entry.originalSize > MAX_EXPANDED_BYTES) throw new Error("压缩文档解压大小超过 48MB 上限");
    return true;
  } });
}

function unzipText(buf: Buffer, name: string): string {
  const entry = unzipEntry(buf, name);
  return entry ? entry.toString("utf8") : "";
}

function xmlToText(xml: string, sep = ""): string {
  return xml
    .replace(/<w:tab\b[^/]*\/>/g, "\t")
    .replace(/<w:br\b[^/]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/a:p>/g, "\n")
    .replace(/<\/si>/g, "\n")
    .replace(/<[^>]+>/g, sep)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1]!;
      swapped[i - 1] = buf[i]!;
    }
    return swapped.toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8");
  }
  return buf.toString("utf8");
}

function stripFileMarkdown(content: string): string {
  return content.replace(new RegExp(FILE_MARKDOWN.source, "g"), (_, label: string) => (label ? `「${label}」` : "")).trim();
}

function clipExtracted(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_TEXT_CHARS)}\n\n…（已截断，原文 ${text.length} 字）`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

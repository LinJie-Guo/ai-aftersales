/** Postgres JSON/JSONB rejects U+0000. Binary tool dumps also blow up event inserts. */

export function sanitizeForJson<T>(value: T): T {
  return walk(value) as T;
}

export function sanitizeText(text: string): string {
  const cleaned = text.replace(/\u0000/g, "");
  if (!cleaned) return cleaned;
  if (!looksBinary(cleaned)) return cleaned;
  return `（二进制或不可打印输出 ${cleaned.length} 字符，已省略。完整内容见 Artifact。）`;
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = walk(item);
    return out;
  }
  return value;
}

function looksBinary(text: string): boolean {
  const n = Math.min(text.length, 2000);
  let bad = 0;
  for (let i = 0; i < n; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0xfffe || code < 9 || (code > 13 && code < 32)) bad += 1;
  }
  return bad / n > 0.04;
}

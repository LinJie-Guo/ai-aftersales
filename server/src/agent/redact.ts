const knownSecrets = new Set<string>();
const sensitiveKey = /^(?:password|passwd|secret|api[_-]?key|token|access[_-]?token|authorization|private[_-]?key|ssh[_-]?key)$/i;

export function registerSecret(value: string): string {
  if (value.length >= 6) knownSecrets.add(value);
  return value;
}

export function redactSensitiveText(text: string): string {
  let clean = text;
  for (const secret of [...knownSecrets].sort((a, b) => b.length - a.length)) clean = clean.split(secret).join("[REDACTED]");
  return clean
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[REDACTED]")
    .replace(/((?:password|passwd|secret|api[_-]?key|token|authorization|private[_-]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+@/g, "$1[REDACTED]@");
}

export function redactEventForClient<T>(value: T): T {
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return redactSensitiveText(item);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, val]) => {
      const reference = typeof val === "string" && /^cred_[0-9a-f-]{36}$/.test(val) || val && typeof val === "object" && !Array.isArray(val) && Object.keys(val).every((k) => ["secretRef", "prefix"].includes(k)) && /^cred_[0-9a-f-]{36}$/.test(String((val as any).secretRef));
      return [key, sensitiveKey.test(key) && !reference ? "[REDACTED]" : walk(val)];
    }));
    return item;
  };
  return walk(value) as T;
}

/** Stream ordinary prose with a short safety tail; hold incomplete secret fields. */
export class StreamingRedactor {
  private pending = "";
  push(text: string, final = false): string {
    this.pending += text;
    if (final) {
      for (const secret of knownSecrets) for (let size = Math.min(secret.length - 1, this.pending.length); size >= 6; size--) {
        if (this.pending.endsWith(secret.slice(0, size))) { this.pending = this.pending.slice(0, -size) + "[REDACTED]"; break; }
      }
      const result = redactSensitiveText(this.pending); this.pending = ""; return result;
    }
    let end = Math.max(this.pending.lastIndexOf("\n") + 1, this.pending.length - 96, 0);
    // Never cut inside a syntactic credential; wait for its terminating token.
    for (const match of this.pending.matchAll(/\b(?:password|passwd|secret|api[_-]?key|token|authorization|private[_-]?key)\s*[:=]\s*|\bBearer\s+|\bsk-/gi)) {
      const start = match.index!, valueStart = start + match[0].length;
      const tail = this.pending.slice(valueStart);
      const quoted = tail.startsWith('"') || tail.startsWith("'");
      const value = quoted ? /^(?:"(?:\\.|[^"\\])*"|'[^']*')/.exec(tail) : /^[^\s,;]+(?=[\s,;])/.exec(tail);
      if (!value || valueStart + value[0].length > end) end = Math.min(end, start);
    }
    const pem = this.pending.indexOf("-----BEGIN");
    if (pem >= 0 && !this.pending.includes("-----END", pem)) end = Math.min(end, pem);
    for (const secret of knownSecrets) {
      const found = this.pending.indexOf(secret);
      if (found >= 0 && found < end && found + secret.length > end) end = found;
      for (let size = Math.min(secret.length - 1, this.pending.length); size > 0; size--) {
        if (this.pending.endsWith(secret.slice(0, size))) { end = Math.min(end, this.pending.length - size); break; }
      }
    }
    if (!end) return "";
    const result = redactSensitiveText(this.pending.slice(0, end));
    this.pending = this.pending.slice(end);
    return result;
  }
}

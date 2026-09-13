import { redactSensitiveText, registerSecret } from "./redact.ts";

/** Session-scoped values. ArtifactStore persists only an authenticated encrypted
 * snapshot, separately from model-visible artifacts and events. */
export class CredentialVault {
  private readonly values = new Map<string, { value: string; expires: number }>();

  capture(text: string): string {
    const refs: string[] = [];
    const fields = /["']?\b([\w.-]{0,96}(?:password|passwd|secret|token|api[_-]?key|_pass))["']?[ \t]*[:=][ \t]*("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^\r\n,;]+)/gi;
    for (const match of text.matchAll(fields)) {
      let value = match[2].trim();
      if (value.startsWith('"')) {
        try { value = JSON.parse(value); } catch { continue; }
      } else if (value.startsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
      else value = value.replace(/\s+#.*$/, "").trimEnd();
      if (!value || value.length > 4096 || /[\0\r\n]|\[REDACTED|\$\{|^ENC\(|^\*+$|^null$/i.test(value)) continue;
      this.prune();
      const existing = [...this.values].find(([, entry]) => entry.value === value)?.[0];
      const ref = existing || `cred_${crypto.randomUUID()}`;
      if (!existing && this.values.size >= 128) continue;
      this.values.set(ref, { value, expires: Date.now() + 30 * 60_000 });
      registerSecret(value);
      refs.push(`- 字段「${match[1]}」 → ${ref}`);
    }
    // The shared redactor deliberately ignores very short registered strings.
    // Within this credential-bearing output, redact even short values on echo.
    let safe = text;
    for (const value of [...new Set([...this.values.values()].map((entry) => entry.value))].sort((a, b) => b.length - a.length)) {
      if (value.length >= 6) safe = safe.split(value).join("[REDACTED]");
      else {
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        safe = safe.replace(new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "g"), "[REDACTED]");
      }
    }
    safe = redactSensitiveText(safe);
    return refs.length ? `${safe}\n\n【可用凭据引用，仅限当前会话】\n${[...new Set(refs)].join("\n")}\n查询工具直接传凭据 ref；HTTP 字段支持引用字符串或 {secretRef: ref}，或通过已审批 bash.credentialEnv 绑定凭据变量。不要打印变量值。引用 30 分钟有效，过期后重新读取来源配置。` : safe;
  }

  seal(encrypt: (text: string) => string): string {
    this.prune();
    return encrypt(JSON.stringify([...this.values]));
  }

  restore(ciphertext: string, decrypt: (text: string) => string): void {
    const text = decrypt(ciphertext);
    if (!text) throw new Error("会话凭据存储无法解密，请恢复原加密密钥");
    const entries = JSON.parse(text);
    if (!Array.isArray(entries) || entries.length > 128) throw new Error("会话凭据存储损坏");
    for (const [ref, entry] of entries) {
      if (!/^cred_[0-9a-f-]{36}$/.test(ref) || typeof entry?.value !== "string" || !Number.isFinite(entry.expires)) throw new Error("会话凭据存储损坏");
      if (entry.expires > Date.now()) { this.values.set(ref, entry); registerSecret(entry.value); }
    }
  }

  bind(input: unknown): Array<{ variable: string; value: string }> {
    this.prune();
    if (input == null) return [];
    if (!Array.isArray(input) || input.length > 16) throw new Error("credentialEnv 必须是最多 16 项的数组");
    const seen = new Set<string>();
    return input.map((item) => {
      if (!item || typeof item !== "object" || typeof item.variable !== "string" || item.variable.length > 64 || !/^(?:CRED_[A-Z0-9_]+|[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|API_KEY|SECRET))$/.test(item.variable)) throw new Error("凭据变量名使用 CRED_ 前缀，或以 PASSWORD/PASSWD/TOKEN/API_KEY/SECRET 结尾；禁止 shell 控制变量");
      if (seen.has(item.variable)) throw new Error("凭据变量名重复");
      seen.add(item.variable);
      const entry = this.values.get(String(item.ref));
      if (!entry) throw new Error("凭据引用无效或已过期。请重新读取已授权的配置来源取得新引用，不要猜测密码或使用脱敏占位符");
      return { variable: item.variable, value: entry.value };
    });
  }

  private prune() {
    for (const [ref, entry] of this.values) if (entry.expires <= Date.now()) this.values.delete(ref);
  }
}

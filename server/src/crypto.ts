import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync } from "node:crypto";

import { config } from "./config.ts";
import { registerSecret } from "./agent/redact.ts";

function key(secret = config.secretEncryptionKey): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function encrypt(value: string | null | undefined): string {
  if (!value) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function fernetKeys(secret: string): Buffer[] {
  const secrets = [secret];
  const keys: Buffer[] = [];
  const seen = new Set<string>();
  for (const secret of secrets) {
    for (const raw of [
      (() => {
        try {
          const buf = Buffer.from(secret, "base64url");
          return buf.length === 32 ? buf : null;
        } catch {
          return null;
        }
      })(),
      (() => {
        try {
          const buf = Buffer.from(secret, "base64");
          return buf.length === 32 ? buf : null;
        } catch {
          return null;
        }
      })(),
      createHash("sha256").update(secret).digest(),
    ]) {
      if (!raw) continue;
      const id = raw.toString("hex");
      if (seen.has(id)) continue;
      seen.add(id);
      keys.push(raw);
    }
  }
  return keys;
}

function decryptFernet(value: string, secret: string): string {
  if (!value.startsWith("gAAAAA")) return "";
  let buf: Buffer;
  try {
    buf = Buffer.from(value, "base64url");
  } catch {
    return "";
  }
  if (buf[0] !== 0x80 || buf.length < 57) return "";
  const iv = buf.subarray(9, 25);
  const signed = buf.subarray(0, buf.length - 32);
  const hmac = buf.subarray(buf.length - 32);
  const ct = buf.subarray(25, buf.length - 32);
  for (const key32 of fernetKeys(secret)) {
    const expected = createHmac("sha256", key32.subarray(0, 16)).update(signed).digest();
    if (!expected.equals(hmac)) continue;
    try {
      const decipher = createDecipheriv("aes-128-cbc", key32.subarray(16, 32), iv);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch {
      /* try next key */
    }
  }
  return "";
}

export function decrypt(value: string | null | undefined): string {
  return registerSecret(decryptWithKey(value, config.secretEncryptionKey));
}

export function decryptWithKey(value: string | null | undefined, secret: string): string {
  if (!value) return "";
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(value)) return value;
  const fernet = decryptFernet(value, secret);
  if (fernet) return fernet;
  try {
    const buf = Buffer.from(value, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

export function mask(value: string | null | undefined): string {
  if (!value) return "";
  if (value.length <= 6) return "******";
  return `${value.slice(0, 3)}****${value.slice(-2)}`;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const digest = scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${digest}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (stored.startsWith("scrypt$")) {
    const [, salt, digest] = stored.split("$");
    return scryptSync(password, salt, 32).toString("hex") === digest;
  }
  return false;
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const defaultWebDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const dataRoot = process.env.DATA_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data");
const secretFile = path.join(dataRoot, "_secrets.json");
function localSecrets(): { jwt: string; encryption: string } {
  mkdirSync(dataRoot, { recursive: true });
  try {
    writeFileSync(secretFile, JSON.stringify({ jwt: randomBytes(48).toString("base64url"), encryption: randomBytes(48).toString("base64url") }), { mode: 0o600, flag: "wx" });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stored = JSON.parse(readFileSync(secretFile, "utf8"));
  if (typeof stored.jwt !== "string" || stored.jwt.length < 32 || typeof stored.encryption !== "string" || stored.encryption.length < 32) throw new Error("本地密钥文件损坏，请恢复 _secrets.json 备份");
  return stored;
}
const secrets = localSecrets();

export const config = {
  appName: process.env.APP_NAME || "AI 售后系统",
  port: Number(process.env.PORT || 8080),
  databaseUrl: process.env.DATABASE_URL || "postgres://aftersale:aftersale_demo_password_2026@localhost:5432/aftersale",
  webDist: process.env.WEB_DIST || defaultWebDist,
  dataRoot,
  jwtSecret: process.env.JWT_SECRET || secrets.jwt,
  jwtExpireMinutes: Number(process.env.JWT_EXPIRE_MINUTES || 60 * 24),
  secretEncryptionKey: process.env.SECRET_ENCRYPTION_KEY || secrets.encryption,
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "admin123",
  sshDefaultUser: process.env.SSH_DEFAULT_USER || "aftersale",
  sshPrivateKeyPath: process.env.SSH_PRIVATE_KEY_PATH || "",
};

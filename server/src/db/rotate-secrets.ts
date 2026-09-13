import { sql } from "./client.ts";
import { decrypt, decryptWithKey, encrypt } from "../crypto.ts";

/** One transaction: never leave half the database encrypted under a new key. */
export async function rotateLegacySecrets() {
  const oldKeys = ["dev-only-fernet-key-please-override-000000000=", "please-change-me-32bytes-secret-000"];
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(83472011)`;
    for (const [table, id, columns] of [
      ["model_config", "id", ["api_key_enc"]],
      ["project", "id", ["git_token_enc", "git_ssh_key_enc"]],
      ["git_credential", "id", ["token_enc", "ssh_key_enc"]],
      ["customer_env", "customer_id", ["ssh_key_enc"]],
    ] as const) {
      for (const column of columns) {
        const rows = await tx.unsafe(`SELECT ${id} AS id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> '' FOR UPDATE`);
        for (const row of rows) {
          if (decrypt(row.value) && !String(row.value).includes("PRIVATE KEY-----")) continue;
          const plain = decrypt(row.value) || oldKeys.map((key) => decryptWithKey(row.value, key)).find(Boolean);
          if (!plain) throw new Error(`无法解密 ${table}.${column}，请恢复原加密密钥；迁移已回滚`);
          await tx.unsafe(`UPDATE ${table} SET ${column} = $1 WHERE ${id} = $2`, [encrypt(plain), row.id]);
        }
      }
    }
  });
}

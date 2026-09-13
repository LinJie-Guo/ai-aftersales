import { mkdir, writeFile, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

import { sanitizeText } from "../json-safe.ts";
import { redactSensitiveText, redactEventForClient } from "../redact.ts";
import type { ToolSpec } from "./types.ts";
import { CredentialVault } from "../credentials.ts";
import { encrypt, decrypt } from "../../crypto.ts";

export interface ArtifactRef {
  id: string;
  preview: string;
  path: string;
}

export class ArtifactStore {
  readonly credentials = new CredentialVault();
  private initialized?: Promise<void>;
  private credentialWrite: Promise<void> = Promise.resolve();
  constructor(private readonly root: string) {}

  ready(): Promise<void> {
    return this.initialized ??= (async () => {
      let text: string;
      try { text = await readFile(path.join(this.root, "credentials.enc"), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      this.credentials.restore(text, decrypt);
    })();
  }

  private saveCredentials(): Promise<void> {
    const job = this.credentialWrite.then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = path.join(this.root, `credentials-${crypto.randomUUID()}.tmp`);
      await writeFile(temporary, this.credentials.seal(encrypt), { mode: 0o600 });
      await rename(temporary, path.join(this.root, "credentials.enc"));
    });
    this.credentialWrite = job.catch(() => {});
    return job;
  }

  async protect(text: string): Promise<string> {
    await this.ready();
    const safe = this.credentials.capture(text);
    await this.saveCredentials();
    return safe;
  }

  async persistText(kind: string, text: string, meta: Record<string, unknown> = {}): Promise<ArtifactRef> {
    if (!/^[a-z]+$/.test(kind)) throw new Error("非法 Artifact 分类");
    await this.ready();
    text = kind === "env" || kind === "code" ? this.credentials.capture(text) : redactSensitiveText(text);
    if (kind === "env" || kind === "code") await this.saveCredentials();
    const id = crypto.randomUUID();
    const dir = path.join(this.root, kind);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${id}.txt`);
    await writeFile(file, text, "utf8");
    await writeFile(path.join(dir, `${id}.json`), JSON.stringify(redactEventForClient(meta)), "utf8");
    const limit = 8000;
    const clipped = text.length > limit
      ? `${text.slice(0, limit)}\n\n（预览已截断，完整 ${text.length} 字符已写入 Artifact。）`
      : text;
    return { id, preview: `${sanitizeText(clipped)}\n[Artifact ${id}，可用 artifact_read 分页读取]`, path: file };
  }

  async read(id: string, offset = 0, limit = 8000) {
    if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 4 || limit > 16000) throw new Error("非法 Artifact ID 或分页参数");
    for (const kind of ["code", "env", "knowledge", "context", "request"]) {
      let handle;
      try { handle = await open(path.join(this.root, kind, `${id}.txt`), "r"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      try {
        const size = (await handle.stat()).size;
        if (offset > size) throw new Error("offset 超出文件范围");
        const buffer = Buffer.alloc(limit + 4);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        let count = Math.min(limit, bytesRead);
        if (offset + count < size) while (count > 0 && (buffer[count]! & 0xc0) === 0x80) count--;
        return { text: buffer.subarray(0, count).toString("utf8"), nextOffset: offset + count, totalBytes: size, eof: offset + count >= size };
      } finally { await handle.close(); }
    }
    throw new Error("本会话没有该 Artifact");
  }

  readTool(): ToolSpec {
    return {
      name: "artifact_read", description: "按 ID 分页读取本会话完整工具输出或压缩前历史。offset 是字节偏移，后续页使用返回的 nextOffset。",
      parameters: { type: "object", properties: { id: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 4, maximum: 16000 } }, required: ["id"], additionalProperties: false },
      execute: async (args) => { const page = await this.read(String(args.id), Number(args.offset ?? 0), Number(args.limit ?? 8000)); return { status: "success", summary: `${page.text}\n[nextOffset=${page.nextOffset}; totalBytes=${page.totalBytes}; eof=${page.eof}]`, data: page }; },
    };
  }
}

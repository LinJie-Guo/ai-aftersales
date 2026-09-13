import { Client, type ClientChannel } from "ssh2";
import { createHash } from "node:crypto";
import type { SshTarget } from "./ssh.ts";

interface Connection { client: Client; ready: Promise<void>; users: number; idle?: ReturnType<typeof setTimeout>; slots: Array<() => void>; active: number }
const connections = new Map<string, Connection>();

function connection(target: SshTarget): [string, Connection] {
  const key = createHash("sha256").update(JSON.stringify(target)).digest("hex");
  const found = connections.get(key);
  if (found) { clearTimeout(found.idle); return [key, found]; }
  if (connections.size >= 32) throw new Error("SSH 连接池繁忙，请稍后重试");
  const client = new Client();
  const entry: Connection = { client, users: 0, active: 0, slots: [], ready: Promise.resolve() };
  entry.ready = new Promise<void>((resolve, reject) => {
    client.once("ready", resolve);
    client.on("error", reject);
    client.on("close", () => { if (connections.get(key) === entry) connections.delete(key); reject(new Error("SSH 连接已关闭")); });
    client.connect({ host: target.host, port: target.port, username: target.username, privateKey: target.privateKey, readyTimeout: 15000, keepaliveInterval: 10000, keepaliveCountMax: 3 });
  });
  connections.set(key, entry);
  return [key, entry];
}

/** Reuse the authenticated transport, never shell cwd/env. Four channels per
 * target, and idle connections close after 30 seconds. No command retry. */
export async function runPooledSsh(target: SshTarget, command: string, timeoutMs: number, signal?: AbortSignal): Promise<{ output: string; exitCode: number }> {
  signal?.throwIfAborted();
  const [key, entry] = connection(target);
  entry.users++;
  let acquired = false;
  const local = new AbortController();
  const timer = setTimeout(() => local.abort(new Error("SSH 命令执行超时")), Math.max(1000, timeoutMs));
  const combined = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
  try {
    await abortable(entry.ready, combined);
    if (entry.active >= 4) await new Promise<void>((resolve, reject) => {
      const ready = () => { acquired = true; combined.removeEventListener("abort", abort); resolve(); };
      const abort = () => { entry.slots = entry.slots.filter((item) => item !== ready); reject(combined.reason); };
      entry.slots.push(ready); combined.addEventListener("abort", abort, { once: true });
      if (combined.aborted) abort();
    });
    else { acquired = true; entry.active++; }
    combined.throwIfAborted();
    return await new Promise((resolve, reject) => {
      let channel: ClientChannel | undefined, ended = false, size = 0, truncated = false;
      const chunks: Buffer[] = [];
      const finish = (error?: unknown, code?: number | null) => {
        if (ended) return; ended = true; combined.removeEventListener("abort", abort);
        if (error) reject(error); else resolve({ output: Buffer.concat(chunks).toString("utf8") + (truncated ? "\n[输出已达 256KB 上限，请缩小范围]" : ""), exitCode: code ?? -1 });
      };
      const abort = () => { try { channel?.signal("TERM"); channel?.close(); } catch { /* channel already closed */ } finish(combined.reason || new Error("SSH 命令取消")); };
      combined.addEventListener("abort", abort, { once: true });
      entry.client.exec(command, (error, stream) => {
        if (error) { finish(error); return; }
        channel = stream;
        if (ended || combined.aborted) { stream.close(); abort(); return; }
        const append = (data: Buffer) => { const kept = data.subarray(0, Math.max(0, 256 * 1024 - size)); if (kept.length) chunks.push(kept); size += kept.length; truncated ||= kept.length < data.length; };
        stream.on("data", append); stream.stderr.on("data", append);
        stream.on("error", finish); stream.on("close", (code: number | null) => finish(undefined, code));
      });
    });
  } finally {
    clearTimeout(timer);
    if (acquired) {
      const next = entry.slots.shift();
      if (next) next(); // Hand the reserved slot directly to its waiter.
      else entry.active--;
    }
    entry.users--;
    if (!entry.users) {
      entry.idle = setTimeout(() => { entry.client.end(); if (connections.get(key) === entry) connections.delete(key); }, 30000);
      entry.idle.unref();
    }
  }
}
function abortable<T>(job: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    job.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { Context, Next } from "hono";
import { getMimeType } from "hono/utils/mime";

import { config } from "../config.ts";

export async function serveWeb(c: Context, next: Next) {
  const urlPath = c.req.path;
  if (urlPath.startsWith("/api/") || urlPath === "/health") return next();

  const root = path.resolve(config.webDist);
  if (!root || !existsSync(root)) return next();

  const rel = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.(\/|\\|$))+/, "").replace(/^\/+/, "");
  const file = path.resolve(root, rel);
  const inside = file === root || file.startsWith(root + path.sep);
  if (inside && existsSync(file) && statSync(file).isFile()) {
    const mime = getMimeType(file) || "application/octet-stream";
    return new Response(readFileSync(file), { status: 200, headers: { "Content-Type": mime } });
  }

  const index = path.join(root, "index.html");
  if (!existsSync(index)) return next();
  return c.html(readFileSync(index, "utf8"));
}

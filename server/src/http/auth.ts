import { and, eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

import { db } from "../db/client.ts";
import { appUser } from "../db/schema.ts";
import { verifyPassword } from "../crypto.ts";
import { signToken, verifyToken } from "../jwt.ts";
import { attachAccess, resolveRole } from "./access.ts";
import { ALL_PERM_KEYS } from "./permissions.ts";

export async function requireUser(c: Context, next: Next) {
  const header = c.req.header("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "") || (c.req.path.startsWith("/api/v1/files/") ? getCookie(c, "file_session") : "");
  if (!token) return c.json({ detail: "未登录" }, 401);
  try {
    const username = await verifyToken(token);
    const [user] = await db.select().from(appUser).where(eq(appUser.username, username)).limit(1);
    if (!user || !user.active) return c.json({ detail: "账号不可用" }, 401);
    c.set("user", user);
    await attachAccess(c, user);
  } catch {
    return c.json({ detail: "登录已过期" }, 401);
  }
  await next();
}

export async function login(c: Context) {
  const contentType = c.req.header("content-type") || "";
  let username = "";
  let password = "";
  if (contentType.includes("application/json")) {
    const body = await c.req.json();
    username = String(body.username ?? "");
    password = String(body.password ?? "");
  } else {
    const body = await c.req.parseBody();
    username = String(body.username ?? "");
    password = String(body.password ?? "");
  }
  const [user] = await db.select().from(appUser).where(and(eq(appUser.username, username))).limit(1);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return c.json({ detail: "用户名或密码错误" }, 400);
  }
  if (!user.active) return c.json({ detail: "账号已停用" }, 401);
  const token = await signToken(user.username);
  setCookie(c, "file_session", token, { httpOnly: true, sameSite: "Strict", secure: new URL(c.req.url).protocol === "https:", path: "/api/v1/files", maxAge: 86400 });
  const role = await resolveRole(user);
  return c.json({
    accessToken: token,
    access_token: token,
    username: user.username,
    displayName: user.displayName,
    display_name: user.displayName,
    role: role.code,
    roleName: role.name,
    role_name: role.name,
    dataScope: role.dataScope,
    data_scope: role.dataScope,
    permissions: role.builtin && role.code === "admin" ? ALL_PERM_KEYS : role.permissions,
  });
}

export async function logout(c: Context) {
  deleteCookie(c, "file_session", { path: "/api/v1/files" });
  return c.json({ ok: true });
}

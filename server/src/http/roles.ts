import { desc, eq } from "drizzle-orm";
import type { Context } from "hono";

import { db } from "../db/client.ts";
import { appRole, appUser } from "../db/schema.ts";

import { dual, iso, page } from "./legacy.ts";
import { DEFAULT_ROLES, PERMISSIONS, sanitizeDataScope, sanitizePermissions } from "./permissions.ts";

function q(c: Context) {
  return {
    page: Math.max(1, Number(c.req.query("page") || 1)),
    pageSize: Math.min(100, Math.max(1, Number(c.req.query("page_size") || c.req.query("pageSize") || 50))),
    keyword: (c.req.query("keyword") || "").trim(),
  };
}

function serialize(row: typeof appRole.$inferSelect) {
  return dual({
    id: row.id,
    code: row.code,
    name: row.name,
    builtin: row.builtin,
    dataScope: row.dataScope === "all" ? "all" : "assigned",
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

export async function listRoleCatalog(c: Context) {
  return c.json({ items: PERMISSIONS, defaults: DEFAULT_ROLES });
}

export async function listRoles(c: Context) {
  const { page: pageNo, pageSize, keyword } = q(c);
  const rows = await db.select().from(appRole).orderBy(desc(appRole.builtin), desc(appRole.createdAt));
  const filtered = rows.filter((row) => {
    if (!keyword) return true;
    return [row.name, row.code].some((value) => value.toLowerCase().includes(keyword.toLowerCase()));
  });
  const slice = filtered.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  return c.json(page(slice.map(serialize), filtered.length, pageNo, pageSize));
}

export async function createRole(c: Context) {
  const body = await c.req.json();
  const name = String(body.name || "").trim();
  if (name.length < 2 || name.length > 32) return c.json({ detail: "角色名需为 2–32 个字" }, 400);
  const code = `r_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const [row] = await db.insert(appRole).values({
    code,
    name,
    builtin: false,
    dataScope: sanitizeDataScope(body.dataScope || body.data_scope),
    permissions: sanitizePermissions(body.permissions),
  }).returning();
  return c.json(serialize(row));
}

export async function updateRole(c: Context) {
  const id = requiredParam(c, "id");
  const [row] = await db.select().from(appRole).where(eq(appRole.id, id)).limit(1);
  if (!row) return c.json({ detail: "角色不存在" }, 404);
  const body = await c.req.json();
  const name = String(body.name || row.name).trim();
  if (name.length < 2 || name.length > 32) return c.json({ detail: "角色名需为 2–32 个字" }, 400);
  const locked = row.builtin && row.code === "admin";
  await db.update(appRole).set({
    name,
    dataScope: locked ? "all" : sanitizeDataScope(body.dataScope || body.data_scope || row.dataScope),
    permissions: locked ? [...DEFAULT_ROLES[0]!.permissions] : sanitizePermissions(body.permissions ?? row.permissions),
    updatedAt: new Date(),
  }).where(eq(appRole.id, id));
  const [next] = await db.select().from(appRole).where(eq(appRole.id, id)).limit(1);
  return c.json(serialize(next));
}

export async function deleteRole(c: Context) {
  const id = requiredParam(c, "id");
  const [row] = await db.select().from(appRole).where(eq(appRole.id, id)).limit(1);
  if (!row) return c.json({ detail: "角色不存在" }, 404);
  if (row.builtin) return c.json({ detail: "内置角色不能删除" }, 400);
  const [used] = await db.select({ id: appUser.id }).from(appUser).where(eq(appUser.role, row.code)).limit(1);
  if (used) return c.json({ detail: "仍有用户使用该角色，不能删除" }, 400);
  await db.delete(appRole).where(eq(appRole.id, id));
  return c.json({ ok: true });
}
import { requiredParam } from "./params.ts";

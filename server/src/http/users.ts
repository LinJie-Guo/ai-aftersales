import { desc, eq } from "drizzle-orm";
import type { Context } from "hono";

import { hashPassword } from "../crypto.ts";
import { db } from "../db/client.ts";
import { appRole, appUser, customer, userCustomer } from "../db/schema.ts";

import { currentAccess, currentUser, resolveRole } from "./access.ts";
import { dual, iso, page } from "./legacy.ts";
import { ALL_PERM_KEYS } from "./permissions.ts";

function q(c: Context) {
  return {
    page: Math.max(1, Number(c.req.query("page") || 1)),
    pageSize: Math.min(100, Math.max(1, Number(c.req.query("page_size") || c.req.query("pageSize") || 10))),
    keyword: (c.req.query("keyword") || "").trim(),
  };
}

async function customerIdsOf(userId: string): Promise<string[]> {
  const rows = await db.select({ customerId: userCustomer.customerId }).from(userCustomer).where(eq(userCustomer.userId, userId));
  return rows.map((row) => row.customerId);
}

async function findRole(code: string) {
  const [row] = await db.select().from(appRole).where(eq(appRole.code, code)).limit(1);
  return row || null;
}

async function serializeUser(row: typeof appUser.$inferSelect) {
  const customerIds = await customerIdsOf(row.id);
  const names: string[] = [];
  for (const id of customerIds) {
    const [cust] = await db.select({ name: customer.name }).from(customer).where(eq(customer.id, id)).limit(1);
    if (cust) names.push(cust.name);
  }
  const role = await resolveRole(row);
  return dual({
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: role.code,
    roleName: role.name,
    dataScope: role.dataScope,
    active: row.active,
    customerIds,
    customerNames: names,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

async function replaceCustomers(userId: string, ids: unknown) {
  const list = Array.isArray(ids) ? [...new Set(ids.map((id) => String(id || "")).filter(Boolean))] : [];
  await db.delete(userCustomer).where(eq(userCustomer.userId, userId));
  if (list.length) {
    await db.insert(userCustomer).values(list.map((customerId) => ({ userId, customerId })));
  }
}

async function activeAdminCount() {
  const rows = await db.select().from(appUser).where(eq(appUser.role, "admin"));
  return rows.filter((row) => row.active).length;
}

export async function me(c: Context) {
  const user = currentUser(c);
  const access = currentAccess(c);
  const customerIds = await customerIdsOf(user.id);
  return c.json(dual({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: access.role.code,
    roleName: access.role.name,
    dataScope: access.role.dataScope,
    active: user.active,
    permissions: access.role.builtin && access.role.code === "admin" ? ALL_PERM_KEYS : access.role.permissions,
    customerIds: access.allCustomers ? null : customerIds,
  }));
}

export async function listUsers(c: Context) {
  const { page: pageNo, pageSize, keyword } = q(c);
  const rows = await db.select().from(appUser).orderBy(desc(appUser.createdAt));
  const filtered = rows.filter((row) => {
    if (!keyword) return true;
    return [row.username, row.displayName, row.role].some((value) => value.toLowerCase().includes(keyword.toLowerCase()));
  });
  const slice = filtered.slice((pageNo - 1) * pageSize, pageNo * pageSize);
  const items = [];
  for (const row of slice) items.push(await serializeUser(row));
  return c.json(page(items, filtered.length, pageNo, pageSize));
}

export async function createUser(c: Context) {
  const body = await c.req.json();
  const username = String(body.username || "").trim();
  const displayName = String(body.displayName || body.display_name || username).trim();
  const password = String(body.password || "");
  const roleCode = String(body.role || "engineer").trim();
  const role = await findRole(roleCode);
  if (!role) return c.json({ detail: "角色不存在，请先在角色管理中创建" }, 400);
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(username)) return c.json({ detail: "用户名需为 2–32 位字母、数字或 ._- " }, 400);
  if (password.length < 6) return c.json({ detail: "密码至少 6 位" }, 400);
  const [exists] = await db.select({ id: appUser.id }).from(appUser).where(eq(appUser.username, username)).limit(1);
  if (exists) return c.json({ detail: "用户名已存在" }, 400);
  const [row] = await db.insert(appUser).values({
    username,
    displayName,
    passwordHash: hashPassword(password),
    role: role.code,
    active: body.active !== false,
  }).returning();
  if (role.dataScope !== "all") await replaceCustomers(row.id, body.customerIds || body.customer_ids);
  return c.json(await serializeUser(row));
}

export async function updateUser(c: Context) {
  const id = requiredParam(c, "id");
  const body = await c.req.json();
  const [row] = await db.select().from(appUser).where(eq(appUser.id, id)).limit(1);
  if (!row) return c.json({ detail: "用户不存在" }, 404);
  const actor = currentUser(c);
  const nextCode = body.role != null ? String(body.role).trim() : row.role;
  const role = await findRole(nextCode);
  if (!role) return c.json({ detail: "角色不存在" }, 400);
  const active = body.active == null ? row.active : Boolean(body.active);
  const password = body.password != null ? String(body.password) : "";
  if (password && password.length < 6) return c.json({ detail: "密码至少 6 位" }, 400);
  if (row.role === "admin" && (role.code !== "admin" || !active)) {
    if ((await activeAdminCount()) <= 1) return c.json({ detail: "至少保留一名启用中的管理员" }, 400);
  }
  if (row.id === actor.id && row.role === "admin" && role.code !== "admin") return c.json({ detail: "不能取消自己的管理员角色" }, 400);
  const displayName = String(body.displayName || body.display_name || row.displayName).trim();
  await db.update(appUser).set({
    displayName,
    role: role.code,
    active,
    ...(password ? { passwordHash: hashPassword(password) } : {}),
    updatedAt: new Date(),
  }).where(eq(appUser.id, id));
  if (role.dataScope === "all") await db.delete(userCustomer).where(eq(userCustomer.userId, id));
  else if (body.customerIds != null || body.customer_ids != null) {
    await replaceCustomers(id, body.customerIds || body.customer_ids);
  }
  const [next] = await db.select().from(appUser).where(eq(appUser.id, id)).limit(1);
  return c.json(await serializeUser(next));
}
import { requiredParam } from "./params.ts";

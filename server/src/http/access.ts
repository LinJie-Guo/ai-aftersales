import { eq } from "drizzle-orm";
import type { Context, Next } from "hono";

import { db } from "../db/client.ts";
import { appRole, appUser, userCustomer } from "../db/schema.ts";
import { ALL_PERM_KEYS, DEFAULT_ROLES, type DataScope } from "./permissions.ts";

export type AppUser = typeof appUser.$inferSelect;

export interface RoleRecord {
  id?: string;
  code: string;
  name: string;
  builtin: boolean;
  dataScope: DataScope;
  permissions: string[];
}

export interface Access {
  role: RoleRecord;
  has(perm: string): boolean;
  allCustomers: boolean;
}

export function currentUser(c: Context): AppUser {
  return c.get("user") as AppUser;
}

export function currentAccess(c: Context): Access {
  return c.get("access") as Access;
}

export function accessFromRole(role: RoleRecord): Access {
  const all = role.builtin && role.code === "admin";
  return {
    role,
    has(perm: string) {
      return all || role.permissions.includes(perm);
    },
    allCustomers: role.dataScope === "all" || all,
  };
}

export async function resolveRole(user: { role: string }): Promise<RoleRecord> {
  const [row] = await db.select().from(appRole).where(eq(appRole.code, user.role)).limit(1);
  if (row) {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      builtin: row.builtin,
      dataScope: row.dataScope === "all" ? "all" : "assigned",
      permissions: Array.isArray(row.permissions) ? row.permissions : [],
    };
  }
  const fallback = DEFAULT_ROLES.find((item) => item.code === user.role) || DEFAULT_ROLES[2]!;
  return { ...fallback, permissions: [...fallback.permissions] };
}

export async function attachAccess(c: Context, user: AppUser): Promise<Access> {
  const access = accessFromRole(await resolveRole(user));
  c.set("access", access);
  return access;
}

export function canSeeCustomer(ids: string[] | null, customerId: string | null | undefined): boolean {
  if (ids === null) return true;
  if (!customerId) return true;
  return ids.includes(customerId);
}

export async function visibleCustomerIds(c: Context): Promise<string[] | null> {
  const access = currentAccess(c);
  if (access.allCustomers) return null;
  const user = currentUser(c);
  const rows = await db.select({ customerId: userCustomer.customerId }).from(userCustomer).where(eq(userCustomer.userId, user.id));
  return rows.map((row) => row.customerId);
}

export async function canAccessCustomer(c: Context, customerId: string): Promise<boolean> {
  return canSeeCustomer(await visibleCustomerIds(c), customerId);
}

export async function forbidUnlessCustomer(c: Context, customerId: string) {
  if (!(await canAccessCustomer(c, customerId))) {
    return c.json({ detail: "无权访问该客户" }, 403);
  }
  return null;
}

export function canSeeRecord(access: Access, userId: string, handlerId?: string | null): boolean {
  if (access.allCustomers) return true;
  return Boolean(handlerId) && handlerId === userId;
}

export async function forbidUnlessRecord(c: Context, record: { customerId: string; handlerId?: string | null }) {
  const denied = await forbidUnlessCustomer(c, record.customerId);
  if (denied) return denied;
  if (!canSeeRecord(currentAccess(c), currentUser(c).id, record.handlerId)) {
    return c.json({ detail: "无权访问该售后记录" }, 403);
  }
  return null;
}

export function requirePerm(perm: string) {
  return requireAnyPerm(perm);
}

export function requireAnyPerm(...perms: string[]) {
  return async (c: Context, next: Next) => {
    const access = currentAccess(c);
    if (!perms.some((perm) => access.has(perm))) return c.json({ detail: "没有该操作权限" }, 403);
    await next();
  };
}

export const ALL_KEYS = ALL_PERM_KEYS;

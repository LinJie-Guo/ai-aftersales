import { eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { afterSaleRecord, appUser, userCustomer } from "../db/schema.ts";
import { accessFromRole, canSeeCustomer, canSeeRecord, resolveRole } from "../http/access.ts";

export interface ExecutionPolicy {
  actorId: string;
  permission: "code" | "env";
  knowledgeCustomerIds: string[] | null;
}

export function intersectScope(original: string[] | null, current: string[] | null): string[] | null {
  if (original === null) return current;
  if (current === null) return original;
  return original.filter((id) => current.includes(id));
}

export async function authorizePolicy(policy: ExecutionPolicy, recordId: string): Promise<string[] | null> {
  const [actor] = await db.select().from(appUser).where(eq(appUser.id, policy.actorId)).limit(1);
  const [record] = await db.select().from(afterSaleRecord).where(eq(afterSaleRecord.id, recordId)).limit(1);
  if (!actor?.active || !record || record.status === "closed") throw new Error("会话发起人不可用或工单已关闭");
  const access = accessFromRole(await resolveRole(actor));
  const current = access.allCustomers ? null : (await db.select().from(userCustomer).where(eq(userCustomer.userId, actor.id))).map((row) => row.customerId);
  if (!access.has("workbench.use") || !canSeeCustomer(current, record.customerId) || !canSeeRecord(access, actor.id, record.handlerId)) throw new Error("会话发起人的工单权限已失效");
  return intersectScope(policy.knowledgeCustomerIds, current);
}

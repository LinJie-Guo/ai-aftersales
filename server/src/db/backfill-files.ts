import { eq } from "drizzle-orm";
import { db } from "./client.ts";
import { dataAsset, uploadedFile, session, sessionEvent, afterSaleRecord } from "./schema.ts";
import { attachmentsFromMarkdown, attachmentsFromRequest, isSafeStoredName } from "../agent/attachments.ts";

/** Recover ownership from existing associations. Unassociated files remain inaccessible. */
export async function backfillFileOwnership() {
  const add = async (name: string, customerId: string, recordId: string | null) => {
    if (isSafeStoredName(name)) await db.insert(uploadedFile).values({ storedName: name, customerId, recordId }).onConflictDoNothing();
  };
  const events = await db.select({ data: sessionEvent.data, recordId: afterSaleRecord.id, customerId: afterSaleRecord.customerId }).from(sessionEvent).innerJoin(session, eq(session.id, sessionEvent.sessionId)).innerJoin(afterSaleRecord, eq(afterSaleRecord.id, session.recordId)).where(eq(sessionEvent.type, "user/message"));
  for (const row of events) {
    const names = [...attachmentsFromRequest(row.data.attachments), ...attachmentsFromMarkdown(String(row.data.content || ""))];
    for (const item of names) await add(item.storedName, row.customerId, row.recordId);
  }
  for (const row of await db.select().from(afterSaleRecord)) {
    for (const item of attachmentsFromMarkdown(row.description || "")) await add(item.storedName, row.customerId, row.id);
  }
  for (const row of await db.select().from(dataAsset)) {
    const name = row.fileUrl?.match(/\/api\/v1\/files\/([^/?#]+)/)?.[1];
    if (name) await add(decodeURIComponent(name), row.customerId, null);
  }
}

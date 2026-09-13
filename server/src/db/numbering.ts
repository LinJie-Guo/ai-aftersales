import { sql } from "./client.ts";

export function businessDay(now = new Date(), timeZone = "Asia/Shanghai"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)!.value).join("");
}

/** Atomic daily allocation; gaps after failed creates are intentional, numbers never recycle. */
export async function nextDocumentCode(kind: "AS" | "K", now = new Date()): Promise<string> {
  const day = businessDay(now), prefix = `${kind}-${day}-`, pattern = `^${prefix}[0-9]+$`;
  const existing = kind === "AS"
    ? sql`SELECT COALESCE(MAX(substring(code from length(${prefix}) + 1)::bigint), 0) AS n FROM after_sale_record WHERE code ~ ${pattern}`
    : sql`SELECT COALESCE(MAX(substring(code from length(${prefix}) + 1)::bigint), 0) AS n FROM knowledge WHERE code ~ ${pattern}`;
  const [row] = await sql`
    INSERT INTO document_counter (prefix, day, value)
    VALUES (${kind}, ${day}, (SELECT n + 1 FROM (${existing}) AS previous))
    ON CONFLICT (prefix, day) DO UPDATE SET value = GREATEST(document_counter.value, (SELECT n FROM (${existing}) AS previous)) + 1
    RETURNING value`;
  return `${prefix}${String(row.value).padStart(3, "0")}`;
}

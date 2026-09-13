import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { modelConfig } from "../db/schema.ts";
import { decrypt } from "../crypto.ts";
import { OpenAICompatibleTransport } from "./llm.ts";

export interface ModelSnapshot { configId: string; modelName: string; maxContext: number; imageInput?: boolean }
export interface CatalogModel { id: string; name: string; contextWindow?: number; imageInput?: boolean }
const catalogs = new Map<string, { expires: number; items: CatalogModel[] }>();

export async function configuredModel(id?: string) {
  const [row] = await db.select().from(modelConfig).where(id ? eq(modelConfig.id, id) : eq(modelConfig.enabled, true)).orderBy(desc(modelConfig.isDefault)).limit(1);
  if (!row?.enabled || !row.baseUrl || !decrypt(row.apiKeyEnc)) throw new Error("未配置可用模型，或本会话模型配置已停用");
  return row;
}

export async function providerCatalog(row: typeof modelConfig.$inferSelect): Promise<CatalogModel[]> {
  const cacheKey = `${row.id}:${row.updatedAt?.toISOString()}`;
  const cached = catalogs.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.items;
  const response = await fetch(`${row.baseUrl.replace(/\/$/, "")}/models`, { headers: { Authorization: `Bearer ${decrypt(row.apiKeyEnc)}` }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`模型目录暂不可用（${response.status}），可继续使用已配置模型`);
  const body = await response.json() as { data?: Record<string, any>[] };
  const items = (body.data ?? []).map((item): CatalogModel => {
    const modalities = item.architecture?.input_modalities ?? item.input_modalities ?? item.input;
    const contextWindow = Number(item.context_length ?? item.context_window ?? item.max_context);
    return { id: String(item.id || ""), name: String(item.name || item.id || ""),
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow: Math.floor(contextWindow) } : {}),
      ...(Array.isArray(modalities) ? { imageInput: modalities.includes("image") } : {}),
    };
  }).filter((item) => item.id);
  if (catalogs.size > 20) catalogs.clear();
  catalogs.set(cacheKey, { expires: Date.now() + 5 * 60_000, items });
  return items;
}

export function modelSnapshot(row: typeof modelConfig.$inferSelect, requested?: string, catalog: CatalogModel[] = []): ModelSnapshot {
  const modelName = requested?.trim() || row.modelName;
  if (modelName.length > 200 || /[\r\n\0]/.test(modelName)) throw new Error("模型名称无效");
  const hit = catalog.find((item) => item.id === modelName);
  const same = modelName === row.modelName;
  const imageInput = hit?.imageInput ?? (same && typeof row.capabilities.image_input === "boolean" ? row.capabilities.image_input : undefined);
  return { configId: row.id, modelName, maxContext: Math.max(4096, Math.min(hit?.contextWindow ?? (same ? row.maxContext || 128000 : 128000), 2_000_000)), ...(imageInput === undefined ? {} : { imageInput }) };
}

export async function resolveTurnModel(previous?: ModelSnapshot, requested?: string) {
  const row = await configuredModel(previous?.configId);
  const name = requested?.trim() || previous?.modelName || row.modelName;
  let catalog: CatalogModel[] = [];
  if (name !== row.modelName && name !== previous?.modelName) {
    try { catalog = await providerCatalog(row); } catch { /* custom endpoints may not expose /models; capacity is conservatively defaulted. */ }
  }
  const snapshot = name === previous?.modelName ? { ...previous } : modelSnapshot(row, name, catalog);
  const raw = Number(row.temperature);
  return { snapshot, row, transport: new OpenAICompatibleTransport({ baseUrl: row.baseUrl, apiKey: decrypt(row.apiKeyEnc), model: snapshot.modelName,
    imageInput: snapshot.imageInput, temperature: Number.isFinite(raw) ? raw <= 2 ? raw : raw / 100 : 0.2,
    timeoutMs: Math.max(15000, row.timeoutSec * 1000), retry: row.retry,
  }) };
}

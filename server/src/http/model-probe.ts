import { formatLlmError } from "../agent/llm.ts";
import { redactSensitiveText } from "../agent/redact.ts";

export interface ProbeConfig { baseUrl: string; modelName: string; apiKey: string }
export interface ProbeResult { ok: boolean; message: string; model?: string; elapsedMs?: number; upstreamStatus?: number }

/** Resolve an unsaved draft without updating any configuration. Never forward
 * a stored key to a different origin just because the UI sends its mask. */
export function resolveProbeConfig(body: Record<string, unknown>, stored?: ProbeConfig): ProbeConfig {
  const baseUrl = String(body.baseUrl ?? body.base_url ?? stored?.baseUrl ?? "").trim().replace(/\/+$/, "");
  const modelName = String(body.modelName ?? body.model_name ?? stored?.modelName ?? "").trim();
  if (!baseUrl || !modelName) throw new Error("请填写 API 地址和模型名称");
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error("API 地址格式无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("API 地址必须是无账号密码、查询参数的 HTTP(S) 地址");
  let apiKey = String(body.apiKey ?? body.api_key ?? "");
  if (!apiKey || apiKey === "******") {
    if (stored?.apiKey && new URL(stored.baseUrl).origin !== url.origin) throw new Error("API 地址已更换服务商，请填写对应的新密钥后测试；不会向新地址发送已保存密钥");
    apiKey = stored?.apiKey || "";
  }
  if (!apiKey) throw new Error("请填写 API 密钥");
  if (modelName.length > 200 || /[\r\n\0]/.test(modelName + apiKey)) throw new Error("模型名称或 API 密钥格式无效");
  return { baseUrl, modelName, apiKey };
}

export async function probeModelConnection(config: ProbeConfig, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ProbeResult> {
  const start = Date.now(), timeoutMs = options.timeoutMs ?? 20000;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const result = (ok: boolean, message: string, upstreamStatus?: number): ProbeResult => ({ ok, message, model: config.modelName, elapsedMs: Date.now() - start, ...(upstreamStatus ? { upstreamStatus } : {}) });
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST", signal, redirect: "error",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.modelName, stream: false, max_tokens: 32, messages: [{ role: "user", content: "只回复 ok" }] }),
    });
    const text = await response.text();
    if (!response.ok) {
      const safe = text.split(config.apiKey).join("[REDACTED]");
      const message = response.status === 401 || response.status === 403 ? "服务商拒绝认证，请检查 API 密钥及模型访问权限。"
        : response.status === 404 ? "服务商未找到接口或模型，请检查 API 地址和模型名称。"
        : response.status === 429 || response.status === 402 ? formatLlmError(new Error(`LLM 请求失败 ${response.status}: ${safe.slice(0, 2000)}`)).replace(/^模型请求失败[：:]\s*/, "")
        : `服务商返回 HTTP ${response.status}，模型测试未成功。`;
      return result(false, redactSensitiveText(message), response.status);
    }
    let json: any;
    try { json = JSON.parse(text); } catch { return result(false, "服务有响应，但不是兼容的 JSON 格式；请检查 API 地址。", response.status); }
    if (json.error) return result(false, "服务商返回错误响应，未取得有效模型回复。", response.status);
    const message = json.choices?.[0]?.message;
    const reply = message?.content || message?.reasoning || message?.reasoning_content;
    if (typeof reply !== "string" || !reply.trim()) return result(false, "接口已响应，但没有返回模型内容；本次测试未通过。", response.status);
    return result(true, "已收到模型回复，文本连接正常。此测试不验证图片或工具调用能力。", response.status);
  } catch {
    if (deadline.aborted) return result(false, `测试超时：${Math.ceil(timeoutMs / 1000)} 秒内未收到完整响应，请检查网络或稍后重试。`);
    if (options.signal?.aborted) return result(false, "测试已取消。");
    return result(false, "无法连接服务商，请检查 API 地址、网络和 TLS 证书后重试。");
  }
}

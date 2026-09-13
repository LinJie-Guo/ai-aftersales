export function isToolFallback(content: string): boolean {
  return /^(本轮工具已经查到结果，模型没有写成结论，先据实汇总如下：|本轮已执行工具，但模型没有写出结论。|本轮执行记录已保留，但尚未生成最终结论。)/.test(content.trim());
}

export function messageNotice(content: string) {
  const text = content.trim();
  if (text.startsWith("本轮排查暂时受阻：")) return { kind: "warning", title: "排查暂时受阻", detail: "连续多步没有取得新证据，已暂停重复尝试。", hint: "执行记录已保留。请查看过程中的失败原因，补充有效配置或纠正范围后继续。", technical: "" };
  if (isToolFallback(text)) {
    const legacy = "本轮工具已经查到结果，模型没有写成结论，先据实汇总如下：";
    return {
      kind: "partial", title: "尚未生成最终结论",
      detail: "本轮执行记录已保留，工具输出不代表最终结论。",
      hint: "可展开思考过程查看结果，发送「继续」完成分析。",
      technical: text.startsWith(legacy) ? text.slice(legacy.length).trim() : "",
    };
  }
  if (!text.startsWith("模型请求失败")) return null;
  const body = text.replace(/^模型请求失败[：:]\s*/, "").trim();
  if (body.includes("额度已耗尽")) return { kind: "warning", title: "当前模型额度已耗尽", detail: "供应方可用额度已用完，本轮未能完成。", hint: "请等待额度重置，或切换可用模型后继续。执行记录已保留。", technical: "" };
  if (/限流|额度|429|rate.limit|quota/i.test(body)) {
    return { kind: "warning", title: "当前模型暂不可用", detail: "模型触发限流或可用额度不足，本轮未能完成。", hint: "请稍后发送「继续」，或切换模型后继续。", technical: "" };
  }
  if (/image input|不支持看图/i.test(body)) {
    return { kind: "warning", title: "当前模型不支持图片输入", detail: "图片已保留，请选择支持图文的模型继续。", hint: "可在输入框右下角切换模型。", technical: "" };
  }
  if (/tool call|工具结果没写完整|对不上/i.test(body)) {
    return { kind: "warning", title: "本轮分析中断", detail: "上一轮工具调用与结果未能正确衔接。", hint: "发送「继续」重新尝试。", technical: "" };
  }
  return {
    kind: "error", title: "模型请求未完成",
    detail: "模型服务未能完成这次请求，本轮尚无最终结论。",
    hint: "请稍后重试，或切换模型后继续。", technical: body,
  };
}

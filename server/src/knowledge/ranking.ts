const generic = new Set(["知识库", "查询", "统计", "数据", "排查", "问题", "多少", "总数", "数据核对"]);
export function knowledgeKeys(query: string): string[] {
  return [...new Set(query.trim().split(/[\s,，、。？?！!；;：:|]+/).filter((key) => key.length >= 2 && !generic.has(key)))].slice(0, 6);
}

export function knowledgeScore(keys: string[], title: string, summary: string, markdown: string): number {
  const heading = `${title}\n${summary}`.toLowerCase(), body = markdown.toLowerCase();
  let score = 0, bodyMatches = 0, headingMatch = false;
  for (const key of keys) {
    const needle = key.toLowerCase();
    if (title.toLowerCase().includes(needle)) score += 8;
    if (summary.toLowerCase().includes(needle)) score += 5;
    if (heading.includes(needle)) headingMatch = true;
    if (body.includes(needle)) { score += 1; bodyMatches += 1; }
  }
  // A single incidental word buried in a long transcript is not a similar case.
  const specificSingle = keys.length === 1 && (keys[0].length >= 8 || /^[a-z0-9_.:/-]{6,}$/i.test(keys[0]));
  return headingMatch || (bodyMatches >= 2 && keys.length > 1) || (specificSingle && bodyMatches > 0) ? score : 0;
}

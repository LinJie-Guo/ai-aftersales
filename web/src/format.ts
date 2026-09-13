/** 316 → 0.3K，128000 → 128K，1048576 → 1M */
export function formatTokens(n: number): string {
  const value = Math.max(0, Number(n) || 0);
  const scaled = (v: number) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`;
  return `${scaled(value / 1_000_000)}M`;
}

/** 列表页统一时间展示 */
export function formatDateTime(value?: string | null): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("zh-CN", { hour12: false });
}

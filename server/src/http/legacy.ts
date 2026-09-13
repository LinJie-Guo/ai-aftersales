export function dual<T extends Record<string, unknown>>(value: T): T & Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const snake = key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
    extra[snake] = item;
    if (Array.isArray(item)) extra[snake] = item.map((entry) => (entry && typeof entry === "object" ? dual(entry as Record<string, unknown>) : entry));
    else if (item && typeof item === "object" && !(item instanceof Date)) extra[snake] = dual(item as Record<string, unknown>);
  }
  return { ...value, ...extra };
}

export function page<T>(items: T[], total: number, pageNo: number, pageSize: number, extra: Record<string, unknown> = {}) {
  return dual({
    items,
    total,
    page: pageNo,
    pageSize,
    ...extra,
  });
}

export function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

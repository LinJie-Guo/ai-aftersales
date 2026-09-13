const THRESHOLDS = [3, 5, 8] as const;

export class RepeatToolReminder {
  private key = "";
  private count = 0;

  reset(): void {
    this.key = "";
    this.count = 0;
  }

  note(name: string, args: unknown): string | null {
    const next = `${name}:${canonical(args)}`;
    this.count = this.key === next ? this.count + 1 : 1;
    this.key = next;
    if (!THRESHOLDS.includes(this.count as (typeof THRESHOLDS)[number])) return null;
    if (this.count === THRESHOLDS[0]) {
      return "You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.";
    }
    const preview = previewArgs(args);
    return [
      "Repeated tool call detected:",
      `- tool: ${name}`,
      `- consecutive_calls: ${this.count}`,
      `- arguments: ${preview}`,
      "The repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.",
    ].join("\n");
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as object).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function previewArgs(args: unknown, max = 500): string {
  const text = canonical(args);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (+${text.length - max} more chars)`;
}

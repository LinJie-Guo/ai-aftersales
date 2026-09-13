/** Recognize a deliberately small grammar, never execute the supplied shell.
 * Unknown syntax keeps the existing approval path. Paths are validated again
 * by remote_read; no expansion, redirects to files, or compound commands. */
export function readonlyRoute(command: string, workdir?: string): Record<string, unknown> | undefined {
  if (/[\r\n\0]/.test(command)) return;
  let source = command.trim();
  let limit: number | undefined;
  const preview = source.match(/\s+(?:2>&1\s+)?\|\s*head\s+(?:-n\s+|-)(\d+)$/);
  if (preview) { limit = Number(preview[1]); source = source.slice(0, preview.index).trim(); }
  else source = source.replace(/\s+2>&1$/, "");
  if (limit !== undefined && (limit < 1 || limit > 1000)) return;
  const tokens = source.match(/'[^']*'|"[^"]*"|[^\s]+/g) ?? [];
  const parts = tokens.map((token) => /^(['"]).*\1$/.test(token) ? token.slice(1, -1) : token);
  if (!parts.length || parts.some((part) => !part || !/^[a-zA-Z0-9_./ @:+-]+$/.test(part))) return;
  const path = (value = ".") => {
    if (value.startsWith("-")) return;
    const resolved = value.startsWith("/") ? value : workdir?.startsWith("/") ? `${workdir.replace(/\/$/, "")}/${value}` : undefined;
    if (!resolved || resolved.split("/").includes("..") || /^\/(dev|proc|sys)(\/|$)/.test(resolved)) return;
    return resolved;
  };
  const file = (operation: string, value?: string, extra: Record<string, unknown> = {}) => {
    const resolved = path(value);
    return resolved ? { operation, path: resolved, ...extra } : undefined;
  };
  if (parts[0] === "ls") {
    const args = parts.slice(1);
    while (args[0] && /^-[alh]+$/.test(args[0])) args.shift();
    if (args[0] === "--") args.shift();
    if (args.length <= 1) return file("list", args[0]);
  }
  if (parts[0] === "cat" && parts.length === 2) return file("read", parts[1], { limit: limit ?? 120 });
  if (parts[0] === "head" && limit === undefined) {
    const match = parts.length === 4 && parts[1] === "-n" ? [parts[2], parts[3]] : parts.length === 3 && /^-\d+$/.test(parts[1]) ? [parts[1].slice(1), parts[2]] : undefined;
    if (match && /^\d+$/.test(match[0]) && Number(match[0]) > 0 && Number(match[0]) <= 1000) return file("read", match[1], { limit: Number(match[0]) });
  }
  if (parts[0] === "docker" && limit === undefined) {
    if (parts.length === 2 && parts[1] === "ps") return { operation: "containers" };
    if (parts.length === 3 && parts[1] === "inspect") return { operation: "inspect", container: parts[2] };
    if (parts.length === 5 && parts[1] === "logs" && parts[2] === "--tail" && /^\d+$/.test(parts[3]) && Number(parts[3]) > 0 && Number(parts[3]) <= 1000) return { operation: "logs", container: parts[4], limit: Number(parts[3]) };
  }
}

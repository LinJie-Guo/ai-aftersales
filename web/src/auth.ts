export function persistSession(data: {
  username?: string;
  role?: string;
  roleName?: string;
  role_name?: string;
  dataScope?: string;
  data_scope?: string;
  permissions?: string[];
}) {
  if (data.username) localStorage.setItem("username", data.username);
  if (data.role) localStorage.setItem("role", data.role);
  localStorage.setItem("roleName", data.roleName || data.role_name || "");
  localStorage.setItem("dataScope", data.dataScope || data.data_scope || "assigned");
  localStorage.setItem("permissions", JSON.stringify(Array.isArray(data.permissions) ? data.permissions : []));
}

export function clearSession() {
  void fetch("/api/v1/auth/logout", { method: "POST", credentials: "same-origin" });
  localStorage.removeItem("token");
  localStorage.removeItem("username");
  localStorage.removeItem("role");
  localStorage.removeItem("roleName");
  localStorage.removeItem("dataScope");
  localStorage.removeItem("permissions");
}

export function currentPermissions(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem("permissions") || "[]");
    return Array.isArray(raw) ? raw.map(String) : [];
  } catch {
    return [];
  }
}

export function hasPerm(perm: string) {
  if (localStorage.getItem("role") === "admin") return true;
  return currentPermissions().includes(perm);
}

export function firstAllowedPath() {
  const order: [string, string][] = [
    ["records.view", "/records"],
    ["workbench.use", "/workbench"],
    ["customers.view", "/customers"],
    ["projects.view", "/projects"],
    ["knowledge.view", "/knowledge"],
    ["settings.manage", "/settings"],
    ["users.manage", "/users"],
    ["roles.manage", "/roles"],
  ];
  for (const [perm, path] of order) {
    if (hasPerm(perm)) return path;
  }
  return "/records";
}

export function roleLabel(role: string, name?: string) {
  if (name) return name;
  if (role === "admin") return "管理员";
  if (role === "viewer") return "只读";
  if (role === "engineer") return "售后工程师";
  return role || "未分配";
}

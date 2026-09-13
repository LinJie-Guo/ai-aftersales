export const PERMISSIONS = [
  { key: "records.view", group: "售后记录", label: "查看" },
  { key: "records.write", group: "售后记录", label: "新建 / 关闭" },
  { key: "workbench.use", group: "工作区", label: "发起排查" },
  { key: "customers.view", group: "客户信息", label: "查看" },
  { key: "customers.write", group: "客户信息", label: "编辑" },
  { key: "customers.pull", group: "客户信息", label: "拉取代码" },
  { key: "customers.ssh", group: "客户信息", label: "SSH 环境" },
  { key: "projects.view", group: "项目管理", label: "查看" },
  { key: "projects.write", group: "项目管理", label: "编辑" },
  { key: "knowledge.view", group: "知识沉淀", label: "查看" },
  { key: "knowledge.write", group: "知识沉淀", label: "沉淀" },
  { key: "knowledge.delete", group: "知识沉淀", label: "删除" },
  { key: "settings.manage", group: "系统管理", label: "系统设置" },
  { key: "users.manage", group: "系统管理", label: "用户管理" },
  { key: "roles.manage", group: "系统管理", label: "角色管理" },
] as const;

export type PermKey = (typeof PERMISSIONS)[number]["key"];

export const ALL_PERM_KEYS: string[] = PERMISSIONS.map((item) => item.key);

export type DataScope = "all" | "assigned";

export interface RoleSeed {
  code: string;
  name: string;
  builtin: boolean;
  dataScope: DataScope;
  permissions: string[];
}

export const DEFAULT_ROLES: RoleSeed[] = [
  {
    code: "admin",
    name: "管理员",
    builtin: true,
    dataScope: "all",
    permissions: ALL_PERM_KEYS,
  },
  {
    code: "engineer",
    name: "售后工程师",
    builtin: true,
    dataScope: "assigned",
    permissions: [
      "records.view",
      "records.write",
      "workbench.use",
      "customers.view",
      "customers.write",
      "customers.pull",
      "customers.ssh",
      "projects.view",
      "knowledge.view",
      "knowledge.write",
    ],
  },
  {
    code: "viewer",
    name: "只读",
    builtin: true,
    dataScope: "assigned",
    permissions: ["records.view", "customers.view", "projects.view", "knowledge.view"],
  },
];

const IMPLIED: Record<string, string[]> = {
  "records.write": ["records.view"],
  "workbench.use": ["records.view"],
  "customers.write": ["customers.view"],
  "customers.pull": ["customers.view"],
  "customers.ssh": ["customers.view"],
  "projects.write": ["projects.view"],
  "knowledge.write": ["knowledge.view"],
  "knowledge.delete": ["knowledge.view"],
};

export function sanitizePermissions(input: unknown): string[] {
  const allowed = new Set(ALL_PERM_KEYS);
  const list = Array.isArray(input) ? input.map((item) => String(item)) : [];
  const next = new Set(list.filter((key) => allowed.has(key)));
  for (const key of [...next]) {
    for (const extra of IMPLIED[key] || []) next.add(extra);
  }
  return ALL_PERM_KEYS.filter((key) => next.has(key));
}

export function sanitizeDataScope(value: unknown): DataScope {
  return value === "all" ? "all" : "assigned";
}

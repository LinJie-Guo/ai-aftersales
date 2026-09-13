<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { Alert, Button, Col, Divider, Empty, Form, FormItem, Input, Modal, Row, Select, Space, Table, Tag, Tooltip, Upload } from "ant-design-vue";
import type { TableColumnsType } from "ant-design-vue";
import { PlusOutlined, QuestionCircleOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons-vue";
import { api, type Customer, type Project, type CustomerRepo, type DataAsset } from "../api";
import { hasPerm } from "../auth";
import { notify } from "../toast";
import { formatDateTime } from "../format";
import ListPage from "../components/ListPage.vue";
import SecretTextarea from "../components/SecretTextarea.vue";

const customers = ref<Customer[]>([]);
const projects = ref<Project[]>([]);
const query = ref({ keyword: "" });
const applied = ref({ keyword: "" });
const page = ref(1);
const pageSize = ref(10);
const total = ref(0);
const dialog = ref(false);
const editing = ref<string | null>(null);
const saving = ref(false);
const pulling = ref(false);
const pullNotice = ref("");

const assetTypes = [
  { value: "table", label: "表结构" },
  { value: "es", label: "ES 结构" },
  { value: "other", label: "其他文档" },
];
const repoStatus: Record<string, { label: string; cls: string }> = {
  updated: { label: "已更新", cls: "green" },
  need_update: { label: "部分失败", cls: "amber" },
  pulling: { label: "拉取中", cls: "blue" },
  failed: { label: "拉取失败", cls: "red" },
  error: { label: "失败", cls: "red" },
  unknown: { label: "未同步", cls: "gray" },
};

function blankForm() {
  return {
    name: "",
    project_id: projects.value[0]?.id || "",
    branch: "",
    tag: "",
    env_ip: "",
    workdir: "",
    ssh_user: "root",
    ssh_key: "",
    code_status: "unknown",
    code_synced_at: null as string | null,
    assets: [] as DataAsset[],
    repos: [] as CustomerRepo[],
  };
}
const form = ref<any>(blankForm());

let keywordTimer: ReturnType<typeof setTimeout> | undefined;
let pullPollTimer: ReturnType<typeof setInterval> | null = null;

function hasPullingCustomers() {
  return customers.value.some((c) => c.code_status === "pulling");
}

function stopPullPoll() {
  if (pullPollTimer) clearInterval(pullPollTimer);
  pullPollTimer = null;
}

function startPullPoll() {
  if (pullPollTimer || !hasPullingCustomers()) return;
  pullPollTimer = setInterval(async () => {
    if (!hasPullingCustomers()) {
      stopPullPoll();
      return;
    }
    await load();
    if (!hasPullingCustomers()) stopPullPoll();
  }, 3000);
}

async function load() {
  const res = await api.customers({
    page: page.value,
    page_size: pageSize.value,
    keyword: applied.value.keyword.trim() || undefined,
  });
  customers.value = res.items;
  total.value = res.total;
  if (hasPullingCustomers()) startPullPoll();
  else stopPullPoll();
}

async function loadProjects() {
  if (!hasPerm("projects.view") && !hasPerm("customers.write")) return;
  try {
    const res = await api.projects({ page: 1, page_size: 100 });
    projects.value = res.items;
  } catch {
    /* 项目列表失败不应挡住客户列表 */
  }
}

onMounted(() => {
  load();
  loadProjects();
});
onUnmounted(() => {
  stopPullPoll();
  clearTimeout(keywordTimer);
});
watch(page, load);
watch(pageSize, () => {
  page.value = 1;
  load();
});
function search() {
  applied.value = { ...query.value };
  page.value = 1;
  load();
}
function resetQuery() {
  query.value = { keyword: "" };
  search();
}

function openNew() {
  editing.value = null;
  form.value = blankForm();
  pullNotice.value = "";
  rebuildRepos();
  dialog.value = true;
}
async function openEdit(c: Customer) {
  const full = await api.customer(c.id);
  editing.value = c.id;
  pullNotice.value = "";
  form.value = {
    name: full.name,
    project_id: full.project_id,
    branch: full.branch || "",
    tag: full.tag || "",
    env_ip: full.env_ip || "",
    workdir: full.workdir || "",
    ssh_user: full.env?.ssh_user || "root",
    ssh_key: full.env?.ssh_key || "",
    code_status: full.code_status,
    code_synced_at: full.code_synced_at || null,
    assets: (full.assets || []).map((a) => ({ ...a })),
    repos: (full.repos || []).map((r) => ({ ...r })),
  };
  rebuildRepos();
  dialog.value = true;
}

function rebuildRepos() {
  const proj = projects.value.find((p) => p.id === form.value.project_id);
  const templates = proj?.repos || [];
  const existing = new Map<string, CustomerRepo>(form.value.repos.map((r: CustomerRepo) => [r.repo_name, r]));
  form.value.repos = templates.map((t) => {
    const e = existing.get(t.repo_name);
    return {
      repo_name: t.repo_name,
      repo_url: t.repo_url,
      branch: e?.branch || "",
      tag: e?.tag || "",
      commit_id: e?.commit_id || "",
      status: e?.status || "unknown",
    } as CustomerRepo;
  });
}

function addAsset() {
  form.value.assets.push({ name: "", asset_type: "table", content: "", file_url: "" });
}
function removeAsset(i: number) {
  form.value.assets.splice(i, 1);
}
async function uploadAssetFile(file: File, asset: DataAsset) {
  if (!editing.value) {
    notify.warning("请先保存客户后再上传资产文件");
    return false;
  }
  const res = await api.uploadCustomerAsset(editing.value, file);
  asset.file_url = res.view_url;
  if (!asset.name) asset.name = res.file_name;
  notify.success(`已上传 ${res.file_name}`);
  return false;
}

const syncedText = computed(() => {
  if (form.value.code_status === "pulling") return "拉取中…";
  if (!form.value.code_synced_at) return "尚未拉取";
  const d = new Date(form.value.code_synced_at);
  return `已拉取 · ${d.toLocaleString("zh-CN")}`;
});

async function save() {
  if (!form.value.name.trim()) return notify.warning("请填写客户名称");
  if (!form.value.project_id) return notify.warning("请选择所属项目");
  saving.value = true;
  try {
    const payload = {
      ...form.value,
      env: form.value.env_ip
        ? {
            ssh_user: form.value.ssh_user?.trim() || "root",
            ssh_key: form.value.ssh_key || "",
          }
        : undefined,
      repos: form.value.repos.map((r: CustomerRepo) => ({
        ...r,
        branch: r.branch || form.value.branch || null,
        tag: r.tag || form.value.tag || null,
      })),
    };
    if (editing.value) await api.updateCustomer(editing.value, payload);
    else editing.value = (await api.createCustomer(payload)).id;
    await load();
    await loadProjects();
    notify.success("已保存客户");
    dialog.value = false;
  } finally {
    saving.value = false;
  }
}

function applyPulledRepos(repos: Array<{ repo_name?: string; repoName?: string; commit_id?: string; commitId?: string; status?: string }>) {
  const byName = new Map(repos.map((repo) => [repo.repo_name || repo.repoName, repo]));
  form.value.repos = form.value.repos.map((row: CustomerRepo) => {
    const pulled = byName.get(row.repo_name);
    if (!pulled) return row;
    return {
      ...row,
      commit_id: pulled.commit_id || pulled.commitId || row.commit_id,
      status: pulled.status || "updated",
    };
  });
}

async function runPull(id: string, label?: string) {
  pulling.value = true;
  try {
    const res = await api.pullCode(id);
    if (!res.ok) {
      notify.error(res.error || "代码拉取失败", 5000);
      return;
    }
    const repos = res.repos || [];
    const detail = repos.length
      ? repos.map((repo: any) => `${repo.repo_name || repo.repoName} ${repo.commit_id || repo.commitId}`).join(" · ")
      : "";
    const title = label ? `「${label}」已拉取 ${repos.length || ""} 个仓库` : `已拉取 ${repos.length || ""} 个仓库`;
    notify.success(detail ? `${title}：${detail}` : title, 6000);
    if (editing.value === id) {
      applyPulledRepos(repos);
      form.value.code_status = "updated";
      form.value.code_synced_at = res.synced_at || res.syncedAt || new Date().toISOString();
      pullNotice.value = detail ? `拉取成功，已写入 Commit：${detail}` : "拉取成功";
    }
  } catch (e: any) {
    notify.error(e?.response?.data?.error || e?.response?.data?.detail || "代码拉取失败", 5000);
  } finally {
    pulling.value = false;
    await load();
  }
}

async function pullFromModal() {
  if (!editing.value) {
    await save();
    if (!editing.value) return;
  }
  await runPull(editing.value);
}
async function pullRow(c: Customer) {
  await runPull(c.id, c.name);
}

async function testSshFromModal() {
  if (!editing.value) {
    notify.warning("请先保存客户后再测试 SSH");
    return;
  }
  try {
    const res = await api.testSsh(editing.value);
    if (res.ok) {
      notify.success(`SSH 连接成功（${res.user}@${res.host}:${res.port}）`);
    } else {
      notify.error(`SSH 连接失败：${res.error || "未知错误"}`);
    }
  } catch (e: any) {
    notify.error(e?.response?.data?.detail || "SSH 测试失败");
  }
}

const columns: TableColumnsType<Customer> = [
  { title: "客户名称", dataIndex: "name", key: "name", width: 160, ellipsis: true },
  { title: "所属项目", dataIndex: "project_name", key: "project_name", width: 160, ellipsis: true },
  { title: "客户分支", dataIndex: "branch", key: "branch", width: 160, ellipsis: true },
  { title: "Tag", dataIndex: "tag", key: "tag", width: 90, ellipsis: true },
  { title: "环境 IP", dataIndex: "env_ip", key: "env_ip", width: 150, ellipsis: true },
  { title: "工作目录", dataIndex: "workdir", key: "workdir", width: 180, ellipsis: true },
  { title: "本地代码", dataIndex: "code_status", key: "code_status", width: 110 },
  { title: "创建时间", dataIndex: "created_at", key: "created_at", width: 170 },
  { title: "操作", key: "action", width: 140, fixed: "right" },
];

function popupContainer(trigger?: HTMLElement) {
  return trigger?.closest(".ant-modal-wrap") as HTMLElement || document.body;
}
function assetTypeOptions(current?: string) {
  const opts = assetTypes.map((t) => ({ value: t.value, label: t.label }));
  if (current && !opts.some((item) => item.value === current)) {
    opts.push({ value: current, label: current });
  }
  return opts;
}

const statusColor: Record<string, string> = {
  updated: "success",
  need_update: "warning",
  pulling: "blue",
  failed: "error",
  error: "error",
  unknown: "default",
};
</script>

<template>
  <ListPage title="客户信息">
    <template #filters>
      <Form layout="inline">
        <FormItem label="关键字">
          <Input v-model:value="query.keyword" allow-clear placeholder="客户 / 项目 / 分支 / IP" style="width: 240px" @pressEnter="search" />
        </FormItem>
        <FormItem>
          <Space>
            <Button @click="resetQuery">重置</Button>
            <Button type="primary" @click="search"><template #icon><SearchOutlined /></template>搜索</Button>
          </Space>
        </FormItem>
      </Form>
    </template>
    <template #actions>
      <Button @click="load">刷新代码状态</Button>
      <Button v-if="hasPerm('customers.write')" type="primary" @click="openNew"><template #icon><PlusOutlined /></template>添加客户</Button>
      <Button @click="load"><ReloadOutlined /></Button>
    </template>
    <Table
      row-key="id"
      size="small"
      :columns="columns"
      :data-source="customers"
      :scroll="{ x: 1400 }"
      :pagination="{
        current: page,
        pageSize,
        total,
        showSizeChanger: true,
        showTotal: (t: number) => `共 ${t} 条`,
        onChange: (p: number, s: number) => { page = p; pageSize = s; },
      }"
    >
      <template #bodyCell="{ column, record: row }">
        <template v-if="column.key === 'project_name'">{{ row.project_name || "-" }}</template>
        <template v-else-if="column.key === 'branch'">{{ row.branch || "-" }}</template>
        <template v-else-if="column.key === 'tag'">{{ row.tag || "-" }}</template>
        <template v-else-if="column.key === 'env_ip'">{{ row.env_ip || "-" }}</template>
        <template v-else-if="column.key === 'workdir'">{{ row.workdir || "-" }}</template>
        <template v-else-if="column.key === 'code_status'">
          <Tag :color="statusColor[row.code_status] || 'default'" :bordered="false">{{ repoStatus[row.code_status]?.label || row.code_status }}</Tag>
        </template>
        <template v-else-if="column.key === 'created_at'">{{ formatDateTime(row.created_at) }}</template>
        <template v-else-if="column.key === 'action'">
          <div class="acts">
            <a v-if="hasPerm('customers.write')" @click="openEdit(row as Customer)">编辑</a>
            <a v-if="hasPerm('customers.pull')" :class="{ disabled: pulling }" @click="!pulling && pullRow(row as Customer)">{{ pulling ? "拉取中…" : "拉取" }}</a>
          </div>
        </template>
      </template>
    </Table>
  </ListPage>

  <Modal
    v-model:open="dialog"
    :title="editing ? '编辑客户' : '新增客户'"
    width="920px"
    :footer="null"
    destroy-on-close
    :body-style="{ maxHeight: 'calc(100vh - 200px)', overflow: 'auto' }"
  >
    <div class="modal-sub">
      <span>客户信息决定 AI 使用哪份代码，以及从哪里连环境。</span>
      <Tag :color="form.code_status === 'updated' ? 'success' : 'processing'" :bordered="false">{{ syncedText }}</Tag>
    </div>
    <Alert v-if="pullNotice" type="success" show-icon :message="pullNotice" style="margin-bottom: 12px" />

    <Form layout="vertical">
      <Row :gutter="16">
        <Col :span="8">
          <FormItem label="客户名称">
            <Input v-model:value="form.name" placeholder="如 星澜智造有限公司" />
          </FormItem>
        </Col>
        <Col :span="8">
          <FormItem label="所属项目">
            <Select
              v-model:value="form.project_id"
              show-search
              option-filter-prop="label"
              placeholder="搜索并选择项目"
              :options="projects.map((p) => ({ value: p.id, label: p.name }))"
              :get-popup-container="popupContainer"
              @change="rebuildRepos"
            />
          </FormItem>
        </Col>
        <Col :span="8">
          <FormItem label="客户分支">
            <Input v-model:value="form.branch" placeholder="release/es-3.4" />
          </FormItem>
        </Col>
        <Col :span="8">
          <FormItem label="客户 Tag">
            <Input v-model:value="form.tag" placeholder="可选，如 v3.4.2" />
          </FormItem>
        </Col>
        <Col :span="8">
          <FormItem label="代码状态">
            <Input :value="syncedText" disabled />
          </FormItem>
        </Col>
      </Row>

      <Divider orientation="left" plain>环境入口</Divider>
      <Row :gutter="16">
        <Col :span="8">
          <FormItem>
            <template #label>
              环境 IP
              <Tooltip title="填写后 AI 可通过 SSH 登录该服务器排查。需先配置免密登录。">
                <QuestionCircleOutlined class="tip" />
              </Tooltip>
            </template>
            <Input v-model:value="form.env_ip" placeholder="192.0.2.20" />
          </FormItem>
        </Col>
        <Col :span="8">
          <FormItem>
            <template #label>
              工作目录
              <Tooltip title="部署 / 代码目录，AI 登录后以此为排查根目录。">
                <QuestionCircleOutlined class="tip" />
              </Tooltip>
            </template>
            <Input v-model:value="form.workdir" placeholder="/srv/demo/assets" />
          </FormItem>
        </Col>
        <Col :span="8">
          <FormItem>
            <template #label>
              SSH 用户名
              <Tooltip title="登录现场服务器的 Linux 账号，常见为 root。">
                <QuestionCircleOutlined class="tip" />
              </Tooltip>
            </template>
            <Input v-model:value="form.ssh_user" class="mono" placeholder="root" />
          </FormItem>
        </Col>
        <Col :span="24">
          <FormItem>
            <template #label>
              服务器 SSH 私钥
              <Tooltip title="登录环境 IP 的私钥，与 Git 拉代码私钥可以不同。">
                <QuestionCircleOutlined class="tip" />
              </Tooltip>
            </template>
            <SecretTextarea v-model:value="form.ssh_key" :rows="4" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
          </FormItem>
          <Button v-if="editing" @click="testSshFromModal">测试 SSH 连接</Button>
        </Col>
      </Row>

      <Divider orientation="left" plain>
        手动补充资产
        <Button type="link" size="small" @click="addAsset">添加</Button>
      </Divider>
      <Empty v-if="!form.assets.length" description="没有环境时，可补充表结构、ES 或部署说明" />
      <div v-for="(a, i) in form.assets" :key="i" class="asset">
        <Row :gutter="12">
          <Col :span="10"><Input v-model:value="a.name" placeholder="名称" /></Col>
          <Col :span="10">
            <Select
              v-model:value="a.asset_type"
              style="width: 100%"
              :options="assetTypeOptions(a.asset_type)"
              :get-popup-container="popupContainer"
              :popup-match-select-width="false"
              :dropdown-style="{ minWidth: '180px', zIndex: 2200 }"
              popup-class-name="asset-type-dropdown"
            />
          </Col>
          <Col :span="4"><Button type="link" danger @click="removeAsset(i)">删除</Button></Col>
        </Row>
        <Input.TextArea v-model:value="a.content" :rows="3" placeholder="结构内容，或上传文档" style="margin-top: 8px" />
        <Upload :show-upload-list="false" :before-upload="(file: File) => uploadAssetFile(file, a)">
          <Button size="small" style="margin-top: 8px">{{ a.file_url ? "已上传，替换文档" : "上传文档" }}</Button>
        </Upload>
      </div>

      <Divider orientation="left" plain>客户代码仓库</Divider>
      <p class="hint">仓库来自所属项目。分支 / Tag / Commit 留空则用上面的客户默认值。</p>
      <Table
        size="small"
        row-key="repo_name"
        :pagination="false"
        :data-source="form.repos"
        :locale="{ emptyText: '该项目暂无仓库模板，请先在项目管理中配置' }"
        :columns="[
          { title: '仓库名', dataIndex: 'repo_name', width: 140 },
          { title: '仓库地址', dataIndex: 'repo_url', ellipsis: true },
          { title: '分支', key: 'branch', width: 150 },
          { title: 'Tag', key: 'tag', width: 120 },
          { title: 'Commit', key: 'commit_id', width: 160 },
          { title: '状态', key: 'status', width: 90 },
        ]"
      >
        <template #bodyCell="{ column, record: row }">
          <Input v-if="column.key === 'branch'" v-model:value="row.branch" size="small" :placeholder="form.branch || '默认分支'" />
          <Input v-else-if="column.key === 'tag'" v-model:value="row.tag" size="small" :placeholder="form.tag || '不指定'" />
          <Input v-else-if="column.key === 'commit_id'" v-model:value="row.commit_id" class="mono" size="small" placeholder="拉取后自动填入" />
          <Tag v-else-if="column.key === 'status'" :color="statusColor[row.status || 'unknown'] || 'default'" :bordered="false">
            {{ repoStatus[row.status || 'unknown']?.label }}
          </Tag>
        </template>
      </Table>
    </Form>

    <div class="foot">
      <Button @click="dialog = false">取消</Button>
      <Button :loading="pulling" :disabled="pulling" @click="pullFromModal">拉取 / 更新客户代码</Button>
      <Button type="primary" :loading="saving" @click="save">保存客户</Button>
    </div>
  </Modal>
</template>

<style scoped>
.acts { display: inline-flex; gap: 12px; }
.acts a { color: var(--blue); cursor: pointer; }
.acts a.disabled { color: var(--muted); cursor: not-allowed; }
.modal-sub { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 16px; color: rgba(0,0,0,.45); }
.tip { margin-left: 4px; color: rgba(0,0,0,.35); }
.hint { margin: -4px 0 10px; color: rgba(0,0,0,.45); font-size: 12px; }
.asset { padding: 12px; margin-bottom: 12px; border: 1px solid var(--line, #f0f0f0); border-radius: 8px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
</style>

<style>
.asset-type-dropdown { z-index: 2200 !important; min-width: 180px !important; }
.asset-type-dropdown .ant-select-item-option-content { white-space: nowrap; }
</style>

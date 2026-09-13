<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Alert, Button, Col, Collapse, CollapsePanel, Form, FormItem, Input, Modal, Row, Select, Space, Table, Tag } from "ant-design-vue";
import type { TableColumnsType } from "ant-design-vue";
import { PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons-vue";
import { api, type Project } from "../api";
import { hasPerm } from "../auth";
import { notify } from "../toast";
import { formatDateTime } from "../format";
import ListPage from "../components/ListPage.vue";
import SecretTextarea from "../components/SecretTextarea.vue";

const projects = ref<Project[]>([]);
const query = ref({ keyword: "" });
const applied = ref({ keyword: "" });
const page = ref(1);
const pageSize = ref(10);
const total = ref(0);
const repoTotal = ref(0);
const customerTotal = ref(0);

const stats = computed(() => ({
  projects: total.value,
  repos: repoTotal.value,
  customers: customerTotal.value,
}));
const dialog = ref(false);
const editing = ref<string | null>(null);
function emptyForm() {
  return {
    name: "",
    description: "",
    repos: [] as { repo_name: string; repo_url: string }[],
    git_auth_type: "none" as "none" | "ssh" | "token",
    git_username: "",
    git_host: "",
    git_token: "",
    git_ssh_key: "",
  };
}
const form = ref(emptyForm());
const repoText = ref("");
const gitOpen = ref(false);
const testingGit = ref(false);
const gitTest = ref<{ ok: boolean; message: string } | null>(null);

async function load() {
  const res = await api.projects({
    page: page.value,
    page_size: pageSize.value,
    keyword: applied.value.keyword.trim() || undefined,
  });
  projects.value = res.items;
  total.value = res.total;
  repoTotal.value = res.repo_total ?? 0;
  customerTotal.value = res.customer_total ?? 0;
}

onMounted(load);
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

function resetDialogExtras() {
  gitOpen.value = false;
  gitTest.value = null;
}

function openNew() {
  editing.value = null;
  form.value = emptyForm();
  repoText.value = "";
  resetDialogExtras();
  dialog.value = true;
}
function openEdit(p: Project) {
  editing.value = p.id;
  form.value = {
    ...emptyForm(),
    name: p.name,
    description: p.description || "",
    repos: [...p.repos],
    git_auth_type: p.git_auth_type || "none",
    git_username: p.git_username || "",
    git_host: p.git_host || "",
    git_token: p.git_token && p.git_token !== "******" ? p.git_token : "",
    git_ssh_key: p.git_ssh_key && p.git_ssh_key !== "******" ? p.git_ssh_key : "",
  };
  repoText.value = p.repos.map((r) => r.repo_url).join("\n");
  resetDialogExtras();
  dialog.value = true;
}

function authLabel(type?: string) {
  if (type === "ssh") return "SSH";
  if (type === "token") return "Token";
  return "公开";
}

const gitSummary = computed(() => {
  if (form.value.git_auth_type === "ssh") return form.value.git_username ? `SSH · ${form.value.git_username}` : "SSH 私钥";
  if (form.value.git_auth_type === "token") return form.value.git_username ? `Token · ${form.value.git_username}` : "用户名 + Token";
  return "无需授权（公开仓库）";
});
async function parse() {
  const repos = await api.parseRepos(repoText.value);
  form.value.repos = Array.isArray(repos) ? repos : [];
  notify.success(`已识别 ${form.value.repos.length} 个仓库`);
}
async function save() {
  if (!form.value.name.trim()) return notify.warning("请填写项目名称");
  if (!form.value.repos.length && repoText.value.trim()) await parse();
  if (editing.value) await api.updateProject(editing.value, form.value);
  else await api.createProject(form.value);
  dialog.value = false;
  await load();
  notify.success("已保存");
}

async function testGit() {
  testingGit.value = true;
  gitTest.value = null;
  try {
    const repoUrl =
      form.value.repos[0]?.repo_url ||
      repoText.value.split(/[\s,，]+/).find((line) => /^(git@|https?:\/\/|ssh:\/\/)/i.test(line)) ||
      "";
    const r = await api.testProjectGit({
      project_id: editing.value,
      ...form.value,
      repo_url: repoUrl,
    });
    gitTest.value = { ok: true, message: r.message || "授权有效，已连通仓库" };
    notify.success(gitTest.value.message);
  } catch (e: any) {
    const message = e?.response?.data?.detail || e?.response?.data?.error || "Git 授权测试失败";
    gitTest.value = { ok: false, message };
    notify.error(message);
  } finally {
    testingGit.value = false;
  }
}

function onGitCollapse(keys: string | number | (string | number)[]) {
  const list = Array.isArray(keys) ? keys : [keys];
  gitOpen.value = list.includes("git");
}

function popupContainer(trigger?: HTMLElement) {
  return trigger?.closest(".ant-modal-wrap") as HTMLElement || document.body;
}

const columns: TableColumnsType<Project> = [
  { title: "项目名称", dataIndex: "name", key: "name", width: 150 },
  { title: "仓库数量", key: "repoCount", width: 90 },
  { title: "仓库地址", key: "repoNames", ellipsis: true },
  { title: "Git 授权", dataIndex: "git_auth_type", key: "git_auth_type", width: 100 },
  { title: "客户数", dataIndex: "customer_count", key: "customer_count", width: 80 },
  { title: "创建时间", dataIndex: "created_at", key: "created_at", width: 170 },
  { title: "操作", key: "action", width: 80, fixed: "right" },
];
</script>

<template>
  <ListPage title="项目管理" :extra="`${stats.projects} 项目 / ${stats.repos} 仓库 / ${stats.customers} 客户`">
    <template #filters>
      <Form layout="inline">
        <FormItem label="关键字">
          <Input v-model:value="query.keyword" allow-clear placeholder="项目名称 / 仓库" style="width: 240px" @pressEnter="search" />
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
      <Button v-if="hasPerm('projects.write')" type="primary" @click="openNew"><template #icon><PlusOutlined /></template>添加项目</Button>
      <Button @click="load"><ReloadOutlined /></Button>
    </template>
    <Table
      row-key="id"
      size="small"
      :columns="columns"
      :data-source="projects"
      :scroll="{ x: 1100 }"
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
        <template v-if="column.key === 'repoCount'">{{ row.repos.length }}</template>
        <template v-else-if="column.key === 'repoNames'">{{ (row as Project).repos.map((r) => r.repo_name).join("、") || "-" }}</template>
        <template v-else-if="column.key === 'git_auth_type'">
          <Tag :color="row.git_auth_type === 'none' || !row.git_auth_type ? 'default' : 'processing'" :bordered="false">{{ authLabel(row.git_auth_type) }}</Tag>
        </template>
        <template v-else-if="column.key === 'created_at'">{{ formatDateTime(row.created_at) }}</template>
        <template v-else-if="column.key === 'action'">
          <div class="acts"><a v-if="hasPerm('projects.write')" @click="openEdit(row as Project)">修改</a></div>
        </template>
      </template>
    </Table>
  </ListPage>

  <Modal
    v-model:open="dialog"
    :title="editing ? '编辑项目' : '新增项目'"
    width="860px"
    :footer="null"
    destroy-on-close
    :body-style="{ maxHeight: 'calc(100vh - 200px)', overflow: 'auto' }"
  >
    <Form layout="vertical">
      <FormItem label="项目名称">
        <Input v-model:value="form.name" placeholder="如 ES主线" />
      </FormItem>
      <FormItem label="批量仓库地址（每行一个）">
        <Input.TextArea
          v-model:value="repoText"
          :rows="5"
          placeholder="git@git.example.com:demo/es-web.git&#10;git@git.example.com:demo/es-api.git"
        />
      </FormItem>
      <Button type="primary" @click="parse">识别仓库</Button>
      <div class="repo-result">
        <Table
          size="small"
          row-key="repo_url"
          :pagination="false"
          :data-source="form.repos"
          :locale="{ emptyText: '粘贴地址后点击「识别仓库」' }"
          :columns="[
            { title: '#', key: 'idx', width: 48 },
            { title: '仓库名', dataIndex: 'repo_name', width: 160 },
            { title: '仓库地址', dataIndex: 'repo_url' },
          ]"
        >
          <template #bodyCell="{ column, index }">
            <span v-if="column.key === 'idx'">{{ index + 1 }}</span>
          </template>
        </Table>
      </div>

        <Collapse :active-key="gitOpen ? ['git'] : []" ghost @change="onGitCollapse">
        <CollapsePanel key="git" :header="`Git 授权 · ${gitSummary}`">
          <p class="hint">公开仓库保持「无需授权」。私有仓库按仓库地址配置 SSH 或 Token，仅对本项目生效。</p>
          <Row :gutter="16">
            <Col :span="8">
              <FormItem label="授权方式" class="auth-pick">
                <Select
                  v-model:value="form.git_auth_type"
                  :get-popup-container="popupContainer"
                  :dropdown-style="{ zIndex: 2200 }"
                  popup-class-name="git-auth-dropdown"
                  :options="[
                    { value: 'none', label: '无需授权（公开仓库）' },
                    { value: 'ssh', label: 'SSH 私钥' },
                    { value: 'token', label: '用户名 + Token' },
                  ]"
                />
              </FormItem>
            </Col>
            <Col v-if="form.git_auth_type !== 'none'" :span="8">
              <FormItem label="Git 用户名"><Input v-model:value="form.git_username" placeholder="可选" /></FormItem>
            </Col>
            <Col v-if="form.git_auth_type !== 'none'" :span="8">
              <FormItem label="仓库域名"><Input v-model:value="form.git_host" class="mono" placeholder="gitee.com / gitlab.com" /></FormItem>
            </Col>
            <Col v-if="form.git_auth_type === 'token'" :span="24">
              <FormItem label="Access Token"><Input.Password v-model:value="form.git_token" class="mono" autocomplete="off" /></FormItem>
            </Col>
            <Col v-if="form.git_auth_type === 'ssh'" :span="24">
              <FormItem label="SSH 私钥">
                <SecretTextarea v-model:value="form.git_ssh_key" :rows="5" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
              </FormItem>
            </Col>
          </Row>
          <Button :loading="testingGit" @click="testGit">{{ testingGit ? "测试中…" : "测试授权" }}</Button>
          <Alert v-if="gitTest" :type="gitTest.ok ? 'success' : 'error'" :message="gitTest.message" show-icon style="margin-top: 12px" />
        </CollapsePanel>
      </Collapse>
    </Form>
    <div class="foot">
      <Button @click="dialog = false">取消</Button>
      <Button type="primary" @click="save">保存项目</Button>
    </div>
  </Modal>
</template>

<style scoped>
.acts a { color: var(--blue); cursor: pointer; }
.repo-result { margin: 12px 0 8px; }
.hint { color: var(--muted); font-size: 12px; margin-bottom: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.auth-pick { overflow: visible; }
.auth-pick :deep(.ant-select-dropdown) { z-index: 2200; }
</style>

<style>
.git-auth-dropdown { z-index: 2200 !important; }
</style>

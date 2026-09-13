<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { Button, Form, FormItem, Input, Modal, Select, Space, Table, Tag } from "ant-design-vue";
import type { TableColumnsType } from "ant-design-vue";
import { DownOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons-vue";
import { FileText, X } from "lucide-vue-next";
import { api, type Customer, type RecordItem } from "../api";
import { hasPerm } from "../auth";
import { notify } from "../toast";
import { formatDateTime } from "../format";
import ListPage from "../components/ListPage.vue";
import KnowledgeToggle from "../components/KnowledgeToggle.vue";

const router = useRouter();
const records = ref<RecordItem[]>([]);
const customers = ref<Customer[]>([]);
const query = ref({ keyword: "", priority: undefined as string | undefined, status: undefined as string | undefined });
const applied = ref({ ...query.value });
const page = ref(1);
const pageSize = ref(10);
const total = ref(0);
const loading = ref(false);
const dialog = ref(false);
const creating = ref(false);
const form = ref({ customer_id: undefined as string | undefined, title: "", priority: "p1", question: "", referenceKnowledge: false });
const dragging = ref(false);

interface Attachment { file_name: string; view_url: string; mime_type: string; is_image: boolean; file?: File; }
const attachments = ref<Attachment[]>([]);

async function uploadFiles(files: FileList | File[]) {
  for (const file of Array.from(files)) {
    if (file.size > 12 * 1024 * 1024) {
      notify.error(`${file.name} 超过 12MB`);
      continue;
    }
    attachments.value.push({
      file_name: file.name,
      view_url: URL.createObjectURL(file),
      mime_type: file.type,
      is_image: (file.type || "").startsWith("image/"),
      file,
    });
  }
}
function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.items || [])
    .filter((it) => it.kind === "file")
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f);
  if (files.length) { e.preventDefault(); uploadFiles(files); }
}
function onDrop(e: DragEvent) {
  dragging.value = false;
  if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
}
function removeAttachment(i: number) { attachments.value.splice(i, 1); }

const priorityMeta: Record<string, { label: string; color: string }> = {
  p0: { label: "P0 紧急", color: "red" },
  p1: { label: "P1 高", color: "orange" },
  p2: { label: "P2 普通", color: "default" },
};
const statusMeta: Record<string, { label: string; color: string }> = {
  processing: { label: "排查中", color: "processing" },
  located: { label: "排查中", color: "processing" },
  await_customer: { label: "排查中", color: "processing" },
  closed: { label: "已关闭", color: "default" },
};

async function load() {
  loading.value = true;
  try {
    const res = await api.records({
      page: page.value,
      page_size: pageSize.value,
      keyword: applied.value.keyword.trim() || undefined,
      priority: applied.value.priority || undefined,
      status: applied.value.status || undefined,
    });
    records.value = res.items;
    total.value = res.total;
  } finally {
    loading.value = false;
  }
}

async function loadCustomers() {
  const items: Customer[] = [];
  let pageNo = 1;
  const size = 100;
  while (true) {
    const res = await api.customers({ page: pageNo, page_size: size });
    items.push(...res.items);
    if (items.length >= res.total || res.items.length === 0) break;
    pageNo += 1;
  }
  customers.value = items;
}

onMounted(() => {
  load();
  loadCustomers().catch(() => undefined);
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
  query.value = { keyword: "", priority: undefined, status: undefined };
  search();
}

function norm(value: string) {
  return value.toLowerCase().replace(/[\s_\-]+/g, "");
}

function filterCustomer(input: string, option: any) {
  const query = norm(input);
  if (!query) return true;
  const raw = String(option?.label ?? option?.title ?? customers.value.find((c) => c.id === option?.value)?.name ?? "");
  const text = norm(raw);
  if (text.includes(query) || raw.toLowerCase().includes(input.trim().toLowerCase())) return true;
  let i = 0;
  for (const ch of text) {
    if (ch === query[i]) i += 1;
    if (i >= query.length) return true;
  }
  return false;
}

function openNew() {
  form.value = { customer_id: undefined, title: "", priority: "p1", question: "", referenceKnowledge: false };
  attachments.value = [];
  void loadCustomers();
  dialog.value = true;
}
async function createRecord() {
  if (creating.value) return;
  if (!form.value.customer_id || !form.value.title.trim()) return notify.warning("请选择客户并填写问题标题");
  if (!form.value.question.trim() && !attachments.value.length) return notify.warning("请填写问题描述或上传截图 / 文档");
  const submitted = { ...form.value };
  const submittedAttachments = [...attachments.value];
  creating.value = true;
  try {
    const rec = await api.createRecord({
      customer_id: submitted.customer_id,
      title: submitted.title.trim(),
      description: submitted.question.trim(),
      priority: submitted.priority,
    });
    const uploaded: { file_name: string; stored_name: string; view_url: string; mime_type: string; is_image: boolean }[] = [];
    for (const a of submittedAttachments) {
      if (!a.file) continue;
      try {
        const res = await api.uploadToRecord(rec.id, a.file);
        uploaded.push({
          file_name: res.file_name || a.file_name,
          stored_name: res.stored_name || res.storedName || "",
          view_url: res.view_url || a.view_url,
          mime_type: res.mime_type || a.mime_type,
          is_image: Boolean(res.is_image ?? a.is_image),
        });
      } catch {
        notify.error(`上传失败：${a.file_name}`);
      }
    }
    if (submitted.question.trim() || uploaded.length || submitted.referenceKnowledge) {
      sessionStorage.setItem(`aftersale:draft:${rec.id}`, JSON.stringify({
        text: submitted.question.trim(),
        attachments: uploaded,
        referenceKnowledge: submitted.referenceKnowledge,
      }));
    }
    dialog.value = false;
    router.push(`/workbench/${rec.id}`);
  } catch (e: any) {
    notify.error(e?.response?.data?.detail || "创建工单失败");
  } finally {
    creating.value = false;
  }
}
async function sink(row: RecordItem) {
  const ok = await new Promise<boolean>((resolve) => {
    Modal.confirm({
      title: "沉淀知识",
      content: `确认把 ${row.code}「${row.title}」的排查结论沉淀到知识库？`,
      okText: "确认沉淀",
      cancelText: "取消",
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
  if (!ok) return;
  try {
    await api.knowledgeFromRecord(row.id);
    notify.success("已生成知识文档");
    router.push("/knowledge");
  } catch {
    notify.error("沉淀失败，请稍后重试");
  }
}

const columns: TableColumnsType<RecordItem> = [
  { title: "记录号", dataIndex: "code", key: "code", width: 170 },
  { title: "客户", dataIndex: "customer_name", key: "customer_name", width: 130 },
  { title: "问题标题", dataIndex: "title", key: "title", width: 180, ellipsis: true },
  { title: "问题描述", dataIndex: "description", key: "description", ellipsis: true },
  { title: "紧急程度", dataIndex: "priority", key: "priority", width: 100 },
  { title: "轮次", dataIndex: "rounds", key: "rounds", width: 70 },
  { title: "状态", dataIndex: "status", key: "status", width: 110 },
  { title: "处理人", dataIndex: "handler_name", key: "handler_name", width: 90 },
  { title: "创建时间", dataIndex: "created_at", key: "created_at", width: 170 },
  { title: "操作", key: "action", width: 140, fixed: "right" },
];
</script>

<template>
  <ListPage title="售后记录">
    <template #filters>
      <Form layout="inline">
        <FormItem label="关键字">
          <Input v-model:value="query.keyword" allow-clear placeholder="记录号 / 客户 / 问题" style="width: 220px" @pressEnter="search" />
        </FormItem>
        <FormItem label="紧急程度">
          <Select
            v-model:value="query.priority"
            allow-clear
            placeholder="全部"
            style="width: 140px"
            :options="[{ value: 'p0', label: 'P0 紧急' }, { value: 'p1', label: 'P1 高' }, { value: 'p2', label: 'P2 普通' }]"
          />
        </FormItem>
        <FormItem label="处理状态">
          <Select
            v-model:value="query.status"
            allow-clear
            placeholder="全部"
            style="width: 140px"
            :options="[
              { value: 'processing', label: '排查中' },
              { value: 'closed', label: '已关闭' },
            ]"
          />
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
      <Button v-if="hasPerm('records.write')" type="primary" @click="openNew"><template #icon><PlusOutlined /></template>新建排查</Button>
      <Button @click="load"><ReloadOutlined /></Button>
    </template>
    <Table
      row-key="id"
      size="small"
      :columns="columns"
      :data-source="records"
      :loading="loading"
      :scroll="{ x: 1400 }"
      :custom-row="(row: RecordItem) => hasPerm('workbench.use') ? ({ onClick: () => router.push(`/workbench/${row.id}`), style: { cursor: 'pointer' } }) : {}"
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
        <template v-if="column.key === 'priority'">
          <Tag :color="priorityMeta[row.priority]?.color" :bordered="false">{{ priorityMeta[row.priority]?.label || row.priority }}</Tag>
        </template>
        <template v-else-if="column.key === 'status'">
          <Tag :color="statusMeta[row.status]?.color" :bordered="false">{{ statusMeta[row.status]?.label || row.status }}</Tag>
        </template>
        <template v-else-if="column.key === 'description'">{{ row.description || "-" }}</template>
        <template v-else-if="column.key === 'handler_name'">{{ row.handler_name || "-" }}</template>
        <template v-else-if="column.key === 'created_at'">{{ formatDateTime(row.created_at) }}</template>
        <template v-else-if="column.key === 'action'">
          <div class="acts" @click.stop>
            <a v-if="hasPerm('workbench.use')" @click="router.push(`/workbench/${row.id}`)">进入</a>
            <a v-if="hasPerm('knowledge.write')" @click="sink(row as RecordItem)">沉淀</a>
          </div>
        </template>
      </template>
    </Table>
  </ListPage>

  <Modal v-model:open="dialog" title="新建排查" :confirm-loading="creating" ok-text="创建并进入排查" cancel-text="取消" @ok="createRecord">
    <Form layout="vertical">
      <FormItem label="排查客户" class="customer-pick">
        <Select
          v-model:value="form.customer_id"
          show-search
          allow-clear
          :filter-option="filterCustomer"
          placeholder="选择客户，可输入模糊搜索"
          :options="customers.map((c) => ({ value: c.id, label: c.name }))"
          :not-found-content="customers.length ? '没有匹配的客户' : '暂无客户'"
          :get-popup-container="(el: HTMLElement) => el.parentElement || el.ownerDocument.body"
          :dropdown-style="{ zIndex: 2200, maxHeight: '320px' }"
          style="width: 100%"
        >
          <template #suffixIcon><DownOutlined /></template>
        </Select>
      </FormItem>
      <FormItem label="紧急程度">
        <Select
          v-model:value="form.priority"
          :options="[{ value: 'p0', label: 'P0 紧急' }, { value: 'p1', label: 'P1 高' }, { value: 'p2', label: 'P2 普通' }]"
        />
      </FormItem>
      <FormItem label="历史经验">
        <KnowledgeToggle v-model="form.referenceKnowledge" />
        <div class="muted" style="font-size: 12px; margin-top: 6px">可选参考相似工单；实时数据仍以现场查询为准。</div>
      </FormItem>
      <FormItem label="问题标题">
        <Input v-model:value="form.title" placeholder="一句话概括问题" />
      </FormItem>
      <FormItem label="问题描述">
        <div class="drop" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="onDrop">
          <Input.TextArea
            v-model:value="form.question"
            :rows="5"
            placeholder="描述现象、复现步骤、报错信息；可拖拽或粘贴截图、日志、文档"
            @paste="onPaste"
          />
        </div>
        <div v-if="attachments.length" class="atts">
          <span v-for="(a, i) in attachments" :key="i" class="att">
            <img v-if="a.is_image" :src="a.view_url" :alt="a.file_name" />
            <FileText v-else :size="14" />
            <span>{{ a.file_name }}</span>
            <button type="button" @click="removeAttachment(i)"><X :size="13" /></button>
          </span>
        </div>
      </FormItem>
    </Form>
  </Modal>
</template>

<style scoped>
.acts { display: inline-flex; gap: 12px; }
.acts a { color: var(--blue); cursor: pointer; }
.drop.dragging :deep(textarea) { border-color: #1677ff; }
.atts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.att {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 8px; border-radius: 6px; background: rgba(0,0,0,.04); font-size: 12px;
}
.att img { width: 22px; height: 22px; object-fit: cover; border-radius: 4px; }
.att button { border: 0; background: none; display: grid; }
.customer-pick { overflow: visible; }
.customer-pick :deep(.ant-select-dropdown) { z-index: 2200; }
</style>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { Button, Form, FormItem, Input, Modal, Space, Table } from "ant-design-vue";
import type { TableColumnsType } from "ant-design-vue";
import { ReloadOutlined, SearchOutlined } from "@ant-design/icons-vue";
import { api, type Knowledge } from "../api";
import { hasPerm } from "../auth";
import { notify } from "../toast";
import { formatDateTime } from "../format";
import { renderMarkdown } from "../markdown";
import ListPage from "../components/ListPage.vue";

const items = ref<Knowledge[]>([]);
const viewDialog = ref(false);
const detail = ref<Knowledge | null>(null);
const query = ref({ keyword: "" });
const applied = ref({ keyword: "" });
const page = ref(1);
const pageSize = ref(10);
const total = ref(0);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    const res = await api.knowledge({
      page: page.value,
      page_size: pageSize.value,
      keyword: applied.value.keyword.trim() || undefined,
    });
    items.value = res.items;
    total.value = res.total;
  } finally {
    loading.value = false;
  }
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

async function openView(id: string) {
  detail.value = await api.knowledgeDetail(id);
  viewDialog.value = true;
}

async function remove(row: Knowledge) {
  const ok = await new Promise<boolean>((resolve) => {
    Modal.confirm({
      title: "删除知识",
      content: `确认删除「${row.code || row.title}」？删除后不可恢复。`,
      okText: "确认删除",
      okType: "danger",
      cancelText: "取消",
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
  if (!ok) return;
  try {
    await api.deleteKnowledge(row.id);
    if (detail.value?.id === row.id) {
      viewDialog.value = false;
      detail.value = null;
    }
    await load();
    notify.success("已删除");
  } catch {
    notify.error("删除失败");
  }
}

const columns: TableColumnsType<Knowledge> = [
  { title: "编号", dataIndex: "code", key: "code", width: 150 },
  { title: "问题", dataIndex: "title", key: "title", width: 180, ellipsis: true },
  { title: "摘要", dataIndex: "summary", key: "summary", ellipsis: true },
  { title: "客户", dataIndex: "customer_name", key: "customer_name", width: 130 },
  { title: "沉淀时间", dataIndex: "created_at", key: "created_at", width: 170 },
  { title: "操作", key: "action", width: 140, fixed: "right" },
];
</script>

<template>
  <ListPage title="知识沉淀">
    <template #filters>
      <Form layout="inline">
        <FormItem label="关键字">
          <Input v-model:value="query.keyword" allow-clear placeholder="编号 / 标题 / 摘要" style="width: 240px" @pressEnter="search" />
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
      <Button @click="load"><ReloadOutlined /></Button>
    </template>
    <Table
      row-key="id"
      size="small"
      :columns="columns"
      :data-source="items"
      :loading="loading"
      :scroll="{ x: 1100 }"
      :custom-row="(row: Knowledge) => ({ onClick: () => openView(row.id), style: { cursor: 'pointer' } })"
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
        <template v-if="column.key === 'summary'">{{ row.summary || "—" }}</template>
        <template v-else-if="column.key === 'customer_name'">{{ row.customer_name || "—" }}</template>
        <template v-else-if="column.key === 'created_at'">{{ formatDateTime(row.created_at) }}</template>
        <template v-else-if="column.key === 'action'">
          <div class="acts" @click.stop>
            <a @click="openView(row.id)">查看</a>
            <a v-if="hasPerm('knowledge.delete')" class="danger" @click="remove(row as Knowledge)">删除</a>
          </div>
        </template>
      </template>
    </Table>
  </ListPage>

  <Modal v-model:open="viewDialog" :title="detail?.title" :footer="null" width="720px" destroy-on-close>
    <p v-if="detail" class="sub">
      <span class="mono">{{ detail.code }}</span>
      <span v-if="detail.customer_name"> · {{ detail.customer_name }}</span>
      · {{ formatDateTime(detail.created_at) }}
    </p>
    <div v-if="detail" class="doc-md md-body" v-html="renderMarkdown(detail.markdown || '')"></div>
    <div class="foot">
      <Button v-if="detail && hasPerm('knowledge.delete')" danger @click="remove(detail)">删除</Button>
      <Button @click="viewDialog = false">关闭</Button>
    </div>
  </Modal>
</template>

<style scoped>
.acts { display: inline-flex; gap: 12px; }
.acts a { color: var(--blue); cursor: pointer; }
.acts a.danger { color: var(--red); }
.sub { color: var(--muted); margin-bottom: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.doc-md { font-size: 14.5px; line-height: 1.7; }
.doc-md :deep(.md-p) { margin: 0 0 10px; }
.doc-md :deep(.md-h3),
.doc-md :deep(.md-h4) { margin: 16px 0 8px; font-weight: 700; }
.foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
</style>

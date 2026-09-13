<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Button, Checkbox, Form, FormItem, Input, Modal, Radio, RadioGroup, Space, Table, Tag } from "ant-design-vue";
import type { TableColumnsType } from "ant-design-vue";
import { PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons-vue";
import { api, type AppRole, type PermItem } from "../api";
import { notify } from "../toast";
import { formatDateTime } from "../format";
import ListPage from "../components/ListPage.vue";

const items = ref<AppRole[]>([]);
const catalog = ref<PermItem[]>([]);
const query = ref({ keyword: "" });
const applied = ref({ keyword: "" });
const page = ref(1);
const pageSize = ref(10);
const total = ref(0);
const loading = ref(false);
const dialog = ref(false);
const saving = ref(false);
const editing = ref<AppRole | null>(null);

function blank() {
  return {
    name: "",
    data_scope: "assigned" as "all" | "assigned",
    permissions: [] as string[],
  };
}
const form = ref(blank());
const locked = computed(() => editing.value?.builtin && editing.value.code === "admin");

function togglePerm(key: string, checked: boolean) {
  const next = new Set(form.value.permissions);
  if (checked) next.add(key);
  else next.delete(key);
  form.value.permissions = catalog.value.map((item) => item.key).filter((item) => next.has(item));
}

const groups = computed(() => {
  const map = new Map<string, PermItem[]>();
  for (const item of catalog.value) {
    const list = map.get(item.group) || [];
    list.push(item);
    map.set(item.group, list);
  }
  return [...map.entries()];
});

async function load() {
  loading.value = true;
  try {
    const res = await api.roles({
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

async function loadCatalog() {
  const res = await api.roleCatalog();
  catalog.value = res.items || [];
}

onMounted(() => {
  load();
  loadCatalog();
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

function openCreate() {
  editing.value = null;
  form.value = blank();
  dialog.value = true;
}

function openEdit(row: AppRole) {
  editing.value = row;
  form.value = {
    name: row.name,
    data_scope: (row.data_scope || row.dataScope) === "all" ? "all" : "assigned",
    permissions: [...(row.permissions || [])],
  };
  dialog.value = true;
}

async function save() {
  if (form.value.name.trim().length < 2) return notify.warning("角色名至少 2 个字");
  saving.value = true;
  try {
    const payload = {
      name: form.value.name.trim(),
      data_scope: form.value.data_scope,
      permissions: form.value.permissions,
    };
    if (editing.value) await api.updateRole(editing.value.id, payload);
    else await api.createRole(payload);
    dialog.value = false;
    notify.success(editing.value ? "已保存" : "已创建");
    await load();
  } catch (e: any) {
    notify.error(e?.response?.data?.detail || "保存失败");
  } finally {
    saving.value = false;
  }
}

async function remove(row: AppRole) {
  if (row.builtin) return;
  const ok = await new Promise<boolean>((resolve) => {
    Modal.confirm({
      title: "删除角色",
      content: `确认删除角色「${row.name}」？已分配该角色的用户需要先改掉。`,
      okText: "确认删除",
      okType: "danger",
      cancelText: "取消",
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
  if (!ok) return;
  try {
    await api.deleteRole(row.id);
    notify.success("已删除");
    await load();
  } catch (e: any) {
    notify.error(e?.response?.data?.detail || "删除失败");
  }
}

function permLabel(keys: string[]) {
  if (!keys?.length) return "无";
  if (keys.length >= catalog.value.length && catalog.value.length) return "全部权限";
  return `${keys.length} 项`;
}

const columns: TableColumnsType<AppRole> = [
  { title: "角色", dataIndex: "name", key: "name", width: 180 },
  { title: "数据范围", dataIndex: "data_scope", key: "data_scope", width: 140 },
  { title: "功能权限", dataIndex: "permissions", key: "permissions" },
  { title: "更新时间", dataIndex: "updated_at", key: "updated_at", width: 170 },
  { title: "操作", key: "action", width: 140, fixed: "right" },
];
</script>

<template>
  <ListPage title="角色管理">
    <template #filters>
      <Form layout="inline">
        <FormItem label="关键字">
          <Input v-model:value="query.keyword" allow-clear placeholder="角色名" style="width: 220px" @pressEnter="search" />
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
      <Button type="primary" @click="openCreate"><template #icon><PlusOutlined /></template>新建角色</Button>
      <Button @click="load"><ReloadOutlined /></Button>
    </template>
    <Table
      row-key="id"
      size="small"
      :loading="loading"
      :columns="columns"
      :data-source="items"
      :pagination="{
        current: page,
        pageSize,
        total,
        showSizeChanger: true,
        showTotal: (n: number) => `共 ${n} 条`,
        onChange: (p: number, s: number) => { page = p; pageSize = s; },
      }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          <Space>
            <span>{{ record.name }}</span>
            <Tag v-if="record.builtin" color="orange" :bordered="false">内置</Tag>
          </Space>
        </template>
        <template v-else-if="column.key === 'data_scope'">
          {{ (record.data_scope || record.dataScope) === "all" ? "全部客户" : "仅分配的客户" }}
        </template>
        <template v-else-if="column.key === 'permissions'">{{ permLabel(record.permissions) }}</template>
        <template v-else-if="column.key === 'updated_at'">{{ formatDateTime(record.updated_at || record.updatedAt) }}</template>
        <template v-else-if="column.key === 'action'">
          <div class="acts">
            <a @click="openEdit(record as AppRole)">编辑</a>
            <a v-if="!record.builtin" class="danger" @click="remove(record as AppRole)">删除</a>
            <a v-else class="disabled">删除</a>
          </div>
        </template>
      </template>
    </Table>
  </ListPage>

  <Modal v-model:open="dialog" :title="editing ? '编辑角色' : '新建角色'" :confirm-loading="saving" width="640px" @ok="save">
    <Form :label-col="{ span: 4 }" :wrapper-col="{ span: 19 }">
      <FormItem label="角色名">
        <Input v-model:value="form.name" placeholder="例如：现场支持" />
      </FormItem>
      <FormItem label="数据范围">
        <RadioGroup v-model:value="form.data_scope" :disabled="locked">
          <Radio value="assigned">仅分配的客户</Radio>
          <Radio value="all">全部客户</Radio>
        </RadioGroup>
      </FormItem>
      <FormItem label="功能权限">
        <div class="perm-box" :class="{ locked }">
          <div v-for="[group, perms] in groups" :key="group" class="perm-group">
            <div class="perm-group-title">{{ group }}</div>
            <Space wrap>
              <Checkbox
                v-for="item in perms"
                :key="item.key"
                :checked="form.permissions.includes(item.key)"
                :disabled="locked"
                @change="(e: any) => togglePerm(item.key, e.target.checked)"
              >{{ item.label }}</Checkbox>
            </Space>
          </div>
        </div>
        <div v-if="locked" class="hint">管理员拥有全部权限，不能改。</div>
        <div v-else-if="editing?.builtin" class="hint">内置角色可改权限，但不能删除。</div>
      </FormItem>
    </Form>
  </Modal>
</template>

<style scoped>
.perm-box {
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  padding: 8px 12px;
  max-height: 360px;
  overflow: auto;
}
.perm-box.locked { opacity: 0.72; }
.perm-group { padding: 8px 0; border-bottom: 1px solid #f5f5f5; }
.perm-group:last-child { border-bottom: 0; }
.perm-group-title { font-weight: 600; margin-bottom: 6px; }
.hint { margin-top: 8px; color: #8c8c8c; font-size: 12px; }
</style>

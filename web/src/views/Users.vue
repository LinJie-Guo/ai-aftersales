<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Button, Form, FormItem, Input, Modal, Select, Space, Switch, Table, Tag } from "ant-design-vue";
import type { TableColumnsType } from "ant-design-vue";
import { PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons-vue";
import { api, type AppRole, type AppUser, type Customer } from "../api";
import { roleLabel } from "../auth";
import { notify } from "../toast";
import { formatDateTime } from "../format";
import ListPage from "../components/ListPage.vue";

const items = ref<AppUser[]>([]);
const roles = ref<AppRole[]>([]);
const customers = ref<Customer[]>([]);
const query = ref({ keyword: "" });
const applied = ref({ keyword: "" });
const page = ref(1);
const pageSize = ref(10);
const total = ref(0);
const loading = ref(false);
const dialog = ref(false);
const saving = ref(false);
const editing = ref<string | null>(null);

function defaultRoleCode() {
  return roles.value.find((item) => item.code === "engineer")?.code || roles.value[0]?.code || "";
}

function blank() {
  return {
    username: "",
    display_name: "",
    password: "",
    role: defaultRoleCode(),
    active: true,
    customer_ids: [] as string[],
  };
}
const form = ref(blank());
const selectedRole = computed(() => roles.value.find((item) => item.code === form.value.role));
const needCustomers = computed(() => (selectedRole.value?.data_scope || selectedRole.value?.dataScope) !== "all");
const roleOptions = computed(() => roles.value.map((item) => ({
  value: item.code,
  label: item.builtin ? `${item.name}（内置）` : item.name,
})));

async function load() {
  loading.value = true;
  try {
    const res = await api.users({
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

async function loadRoles() {
  const res = await api.roles({ page: 1, page_size: 100 });
  roles.value = res.items;
}

async function loadCustomers() {
  const res = await api.customers({ page: 1, page_size: 100 });
  customers.value = res.items;
}

onMounted(async () => {
  await loadRoles();
  load();
  loadCustomers();
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

function openEdit(row: AppUser) {
  editing.value = row.id;
  form.value = {
    username: row.username,
    display_name: row.display_name || row.displayName || "",
    password: "",
    role: row.role,
    active: row.active !== false,
    customer_ids: row.customer_ids || row.customerIds || [],
  };
  dialog.value = true;
}

async function save() {
  if (!form.value.username.trim()) return notify.warning("请填写用户名");
  if (!form.value.role) return notify.warning("请选择角色");
  if (!editing.value && form.value.password.length < 6) return notify.warning("密码至少 6 位");
  if (editing.value && form.value.password && form.value.password.length < 6) return notify.warning("密码至少 6 位");
  saving.value = true;
  try {
    const payload = {
      username: form.value.username.trim(),
      display_name: form.value.display_name.trim() || form.value.username.trim(),
      password: form.value.password || undefined,
      role: form.value.role,
      active: form.value.active,
      customer_ids: needCustomers.value ? form.value.customer_ids : [],
    };
    if (editing.value) await api.updateUser(editing.value, payload);
    else await api.createUser(payload);
    dialog.value = false;
    notify.success(editing.value ? "已保存" : "已创建");
    await load();
  } catch (e: any) {
    notify.error(e?.response?.data?.detail || "保存失败");
  } finally {
    saving.value = false;
  }
}

function userRoleName(row: AppUser) {
  return row.role_name || row.roleName || roles.value.find((item) => item.code === row.role)?.name || roleLabel(row.role);
}

function allCustomers(row: AppUser) {
  return (row.data_scope || row.dataScope) === "all" || row.role === "admin";
}

const columns: TableColumnsType<AppUser> = [
  { title: "用户名", dataIndex: "username", key: "username", width: 140 },
  { title: "姓名", dataIndex: "display_name", key: "display_name", width: 140 },
  { title: "角色", dataIndex: "role", key: "role", width: 140 },
  { title: "状态", dataIndex: "active", key: "active", width: 90 },
  { title: "可见客户", dataIndex: "customer_names", key: "customer_names", ellipsis: true },
  { title: "创建时间", dataIndex: "created_at", key: "created_at", width: 170 },
  { title: "操作", key: "action", width: 90, fixed: "right" },
];
</script>

<template>
  <ListPage title="用户管理">
    <template #filters>
      <Form layout="inline">
        <FormItem label="关键字">
          <Input v-model:value="query.keyword" allow-clear placeholder="用户名 / 姓名" style="width: 220px" @pressEnter="search" />
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
      <Button type="primary" @click="openCreate"><template #icon><PlusOutlined /></template>新建用户</Button>
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
        <template v-if="column.key === 'display_name'">{{ record.display_name || record.displayName }}</template>
        <template v-else-if="column.key === 'role'">
          <Tag :color="record.role === 'admin' ? 'red' : 'blue'" :bordered="false">{{ userRoleName(record as AppUser) }}</Tag>
        </template>
        <template v-else-if="column.key === 'active'">
          <Tag :color="record.active === false ? 'default' : 'green'" :bordered="false">{{ record.active === false ? "停用" : "启用" }}</Tag>
        </template>
        <template v-else-if="column.key === 'customer_names'">
          <span v-if="allCustomers(record as AppUser)">全部客户</span>
          <span v-else>{{ (record.customer_names || record.customerNames || []).join("、") || "未分配" }}</span>
        </template>
        <template v-else-if="column.key === 'created_at'">{{ formatDateTime(record.created_at || record.createdAt) }}</template>
        <template v-else-if="column.key === 'action'">
          <div class="acts"><a @click="openEdit(record as AppUser)">编辑</a></div>
        </template>
      </template>
    </Table>
  </ListPage>

  <Modal v-model:open="dialog" :title="editing ? '编辑用户' : '新建用户'" :confirm-loading="saving" @ok="save">
    <Form :label-col="{ span: 5 }" :wrapper-col="{ span: 18 }">
      <FormItem label="用户名">
        <Input v-model:value="form.username" :disabled="!!editing" placeholder="字母数字或 ._- " />
      </FormItem>
      <FormItem label="姓名">
        <Input v-model:value="form.display_name" placeholder="显示名" />
      </FormItem>
      <FormItem :label="editing ? '新密码' : '密码'">
        <Input.Password v-model:value="form.password" :placeholder="editing ? '不改请留空' : '至少 6 位'" autocomplete="new-password" />
      </FormItem>
      <FormItem label="角色">
        <Select v-model:value="form.role" :options="roleOptions" placeholder="请选择角色" />
      </FormItem>
      <FormItem v-if="needCustomers" label="可见客户">
        <Select
          v-model:value="form.customer_ids"
          mode="multiple"
          allow-clear
          show-search
          option-filter-prop="label"
          placeholder="不选则看不到任何客户"
          :options="customers.map((item) => ({ value: item.id, label: item.name }))"
        />
      </FormItem>
      <FormItem label="启用">
        <Switch v-model:checked="form.active" />
      </FormItem>
    </Form>
  </Modal>
</template>

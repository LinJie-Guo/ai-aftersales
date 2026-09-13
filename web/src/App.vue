<script setup lang="ts">
import { computed, h, onMounted, ref } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import {
  Avatar, Breadcrumb, Button, ConfigProvider, Divider, Drawer, Dropdown, Layout,
  LayoutContent, LayoutHeader, LayoutSider, Menu, Space,
} from "ant-design-vue";
import {
  BookOutlined, FolderOutlined, SettingOutlined, TeamOutlined,
  ThunderboltOutlined, UnorderedListOutlined, UserOutlined,
} from "@ant-design/icons-vue";
import zhCN from "ant-design-vue/es/locale/zh_CN";
import { Moon, Sun } from "lucide-vue-next";
import { api } from "./api";
import { clearSession, hasPerm, persistSession } from "./auth";
import { useTheme } from "./theme";

const route = useRoute();
const router = useRouter();
const { isDark, primary, presets, themeConfig } = useTheme();
const collapsed = ref(localStorage.getItem("sidebar-collapsed") === "1");
const themeOpen = ref(false);
const isPublic = computed(() => route.meta.public === true);
const isWorkbench = computed(() => route.path.startsWith("/workbench"));
const username = computed(() => localStorage.getItem("username") || "admin");

const crumbs: Record<string, string[]> = {
  "/records": ["售后管理", "售后记录"],
  "/workbench": ["售后管理", "工作区"],
  "/customers": ["基础数据", "客户信息"],
  "/projects": ["基础数据", "项目管理"],
  "/knowledge": ["售后管理", "知识沉淀"],
  "/settings": ["系统管理", "系统设置"],
  "/users": ["系统管理", "用户管理"],
  "/roles": ["系统管理", "角色管理"],
};

onMounted(async () => {
  try {
    const me = await api.me();
    persistSession(me);
  } catch {
    /* keep cached role */
  }
});

const currentCrumbs = computed(() => {
  const key = Object.keys(crumbs).find((path) => route.path.startsWith(path));
  return key ? crumbs[key] : ["售后系统"];
});

const selectedKeys = computed(() => {
  if (route.path.startsWith("/workbench")) return ["/workbench"];
  return [route.path];
});

const openKeys = ref<string[]>(hasPerm("settings.manage") || hasPerm("users.manage") || hasPerm("roles.manage") ? ["system"] : []);

const menuItems = computed(() => {
  const items: any[] = [];
  if (hasPerm("records.view")) items.push({ key: "/records", icon: () => h(UnorderedListOutlined), label: "售后记录" });
  if (hasPerm("workbench.use")) items.push({ key: "/workbench", icon: () => h(ThunderboltOutlined), label: "工作区" });
  if (hasPerm("customers.view")) items.push({ key: "/customers", icon: () => h(TeamOutlined), label: "客户信息" });
  if (hasPerm("projects.view")) items.push({ key: "/projects", icon: () => h(FolderOutlined), label: "项目管理" });
  if (hasPerm("knowledge.view")) items.push({ key: "/knowledge", icon: () => h(BookOutlined), label: "知识沉淀" });
  const system: any[] = [];
  if (hasPerm("settings.manage")) system.push({ key: "/settings", label: "系统设置" });
  if (hasPerm("users.manage")) system.push({ key: "/users", label: "用户管理" });
  if (hasPerm("roles.manage")) system.push({ key: "/roles", label: "角色管理" });
  if (system.length) {
    items.push({
      key: "system",
      icon: () => h(SettingOutlined),
      label: "系统管理",
      children: system,
    });
  }
  return items;
});

function onMenuClick({ key }: { key: string | number }) {
  const path = String(key);
  if (path.startsWith("/")) router.push(path);
}

function onCollapse(value: boolean) {
  collapsed.value = value;
  localStorage.setItem("sidebar-collapsed", value ? "1" : "0");
}

function logout() {
  clearSession();
  router.replace("/login");
}
</script>

<template>
  <ConfigProvider :locale="zhCN" :theme="themeConfig">
    <RouterView v-if="isPublic" />

    <Layout v-else class="app" :class="{ dark: isDark, workbench: isWorkbench }">
      <LayoutSider
        :collapsed="collapsed"
        collapsible
        :theme="isDark ? 'dark' : 'light'"
        :width="220"
        @collapse="onCollapse"
      >
        <div class="brand">
          <div class="logo">售</div>
          <span v-if="!collapsed">AI 售后中枢</span>
        </div>
        <Menu
          mode="inline"
          :inline-collapsed="collapsed"
          :theme="isDark ? 'dark' : 'light'"
          :selected-keys="selectedKeys"
          v-model:open-keys="openKeys"
          :items="menuItems"
          @click="onMenuClick"
        />
      </LayoutSider>

      <Layout>
        <LayoutHeader class="head">
          <Breadcrumb>
            <Breadcrumb.Item>售后系统</Breadcrumb.Item>
            <Breadcrumb.Item v-for="c in currentCrumbs" :key="c">{{ c }}</Breadcrumb.Item>
          </Breadcrumb>
          <Space :size="4">
            <Button type="text" :title="isDark ? '切换浅色' : '切换深色'" @click="isDark = !isDark">
              <Moon v-if="!isDark" :size="16" />
              <Sun v-else :size="16" />
            </Button>
            <Button type="text" title="主题配置" @click="themeOpen = true"><SettingOutlined /></Button>
            <Dropdown :trigger="['click']">
              <Button type="text">
                <Avatar :size="22" :style="{ background: primary }"><UserOutlined /></Avatar>
                <span style="margin-left: 8px">{{ username }}</span>
              </Button>
              <template #overlay>
                <Menu :items="[{ key: 'out', label: '退出登录' }]" @click="logout" />
              </template>
            </Dropdown>
          </Space>
        </LayoutHeader>
        <LayoutContent class="body">
          <RouterView />
        </LayoutContent>
      </Layout>
    </Layout>

    <Drawer v-model:open="themeOpen" title="主题配置" :width="300">
      <div class="theme-label">主题</div>
      <div class="theme-modes">
        <button type="button" :class="{ on: !isDark }" @click="isDark = false">浅色</button>
        <button type="button" :class="{ on: isDark }" @click="isDark = true">深色</button>
      </div>
      <Divider />
      <div class="theme-label">主题色</div>
      <div class="swatches">
        <button
          v-for="color in presets"
          :key="color"
          type="button"
          class="swatch"
          :class="{ on: primary === color }"
          :style="{ background: color }"
          @click="primary = color"
        />
      </div>
    </Drawer>
  </ConfigProvider>
</template>

<style scoped>
.app {
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  --proto-primary: v-bind(primary);
  --proto-head: var(--surface);
  --proto-line: var(--line);
}
.brand {
  height: 56px; display: flex; align-items: center; gap: 10px;
  padding: 0 16px; font-weight: 650;
}
.logo {
  width: 28px; height: 28px; border-radius: 6px;
  background: var(--proto-primary); color: #fff;
  display: grid; place-items: center; font-size: 13px; flex-shrink: 0;
}
.head {
  height: 56px; padding: 0 20px; display: flex;
  align-items: center; justify-content: space-between;
  background: var(--proto-head); border-bottom: 1px solid var(--proto-line);
  line-height: 56px;
}
.body {
  padding: 16px;
  min-height: calc(100vh - 56px);
  background: var(--bg);
  color: var(--text);
}
.app.workbench { height: 100dvh; min-height: 0; overflow: hidden; }
.app.workbench .body { padding: 12px; overflow: hidden; height: calc(100dvh - 56px); min-height: 0; display: flex; flex-direction: column; }
.app.workbench .body :deep(.wb-topbar) { flex-shrink: 0; }
.app.workbench .body :deep(.workbench-layout) { flex: 1; min-height: 0; height: auto; }
.app.workbench .body :deep(.chat-panel) { min-height: 0; }
.theme-label { margin-bottom: 10px; font-weight: 600; }
.theme-modes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.theme-modes button {
  height: 36px; border: 1px solid var(--proto-line); border-radius: 6px; background: transparent; color: var(--text);
}
.theme-modes button.on { border-color: var(--proto-primary); color: var(--proto-primary); }
.swatches { display: flex; flex-wrap: wrap; gap: 10px; }
.swatch {
  width: 22px; height: 22px; border: 0; border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.12);
}
.swatch.on { outline: 2px solid var(--proto-primary); outline-offset: 2px; }
</style>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ChevronDown } from "lucide-vue-next";
import { api } from "../api";
import { hasPerm } from "../auth";
import { notify } from "../toast";

const props = defineProps<{ disabled?: boolean; modelValue?: string }>();
const emit = defineEmits<{ changed: []; "update:modelValue": [value: string] }>();

const canEdit = hasPerm("workbench.use");
const name = ref(props.modelValue || "");
watch(() => props.modelValue, (value) => { name.value = value || ""; });
const open = ref(false);
const query = ref("");
const saving = ref(false);
const loading = ref(false);
const root = ref<HTMLElement | null>(null);
const catalog = ref<{ id: string; name: string; contextWindow?: number; context_window?: number }[]>([]);

function windowLabel(n?: number) {
  if (!n) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

const options = computed(() => {
  const q = query.value.trim().toLowerCase();
  const items = catalog.value.map((item) => {
    const win = windowLabel(item.contextWindow || item.context_window);
    return { id: item.id, label: item.name && item.name !== item.id ? item.name : "", win };
  });
  const filtered = q
    ? items.filter((item) => `${item.id} ${item.label}`.toLowerCase().includes(q))
    : items;
  if (q && !filtered.some((item) => item.id === query.value.trim())) {
    filtered.unshift({ id: query.value.trim(), label: "使用自定义", win: "" });
  }
  return filtered.slice(0, 80);
});

async function load() {
  try {
    const m = await api.availableModels();
    catalog.value = m.items || [];
    if (!props.modelValue) { name.value = String(m?.defaultModel || "").trim(); emit("update:modelValue", name.value); }
  } catch { /* no permission or unset */ }
}

async function loadCatalog() {
  if (!canEdit || loading.value || catalog.value.length) return;
  loading.value = true;
  try {
    const res = await api.availableModels();
    catalog.value = res.items || [];
  } catch (e: any) {
    notify.error(e?.response?.data?.detail || "加载模型列表失败");
  } finally {
    loading.value = false;
  }
}

async function toggle() {
  if (!canEdit || props.disabled || saving.value) return;
  open.value = !open.value;
  if (open.value) {
    query.value = "";
    await loadCatalog();
  }
}

async function pick(id: string) {
  if (!id || id === name.value || saving.value) {
    open.value = false;
    return;
  }
  saving.value = true;
  try {
    name.value = id;
    emit("update:modelValue", id);
    open.value = false;
    emit("changed");
    notify.success(`后续消息使用 ${name.value}，不影响其他会话`);
  } catch (e: any) {
    notify.error(e?.response?.data?.detail || "切换模型失败");
  } finally {
    saving.value = false;
  }
}

function onDocClick(event: MouseEvent) {
  if (!open.value || !root.value) return;
  if (!root.value.contains(event.target as Node)) open.value = false;
}

onMounted(() => {
  load();
  document.addEventListener("mousedown", onDocClick);
});
onUnmounted(() => document.removeEventListener("mousedown", onDocClick));
</script>

<template>
  <div ref="root" class="model-picker">
    <button
      type="button"
      class="model-chip"
      :disabled="!canEdit || disabled || saving"
      :title="canEdit ? '选择此会话后续消息的模型，不修改系统默认配置' : name"
      @click="toggle"
    >
      <span>{{ name || "未配置模型" }}</span>
      <ChevronDown v-if="canEdit" :size="12" />
    </button>
    <div v-if="open" class="model-pop">
      <input v-model="query" class="model-search" placeholder="搜索或输入模型 ID" />
      <div class="model-list">
        <div v-if="loading" class="model-empty">正在加载模型列表…</div>
        <div v-else-if="!options.length" class="model-empty">没有匹配的模型</div>
        <button
          v-for="item in options"
          :key="item.id"
          type="button"
          class="model-option"
          :class="{ on: item.id === name }"
          @click="pick(item.id)"
        >
          <span class="model-id">{{ item.id }}</span>
          <span v-if="item.label || item.win" class="model-meta">{{ [item.label, item.win].filter(Boolean).join(" · ") }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.model-picker { position: relative; min-width: 0; }
.model-chip {
  max-width: 200px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 12.5px;
  padding: 0 2px;
  cursor: pointer;
}
.model-chip span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-chip:hover:not(:disabled) { color: var(--text); }
.model-chip:disabled { cursor: default; }
.model-chip svg { flex: none; color: var(--muted); }
.model-pop {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  width: min(360px, 72vw);
  max-height: 320px;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow);
  z-index: 40;
  overflow: hidden;
}
.model-search {
  border: 0;
  border-bottom: 1px solid var(--line);
  outline: 0;
  padding: 8px 10px;
  font-size: 12.5px;
  background: var(--surface);
  color: var(--text);
}
.model-list { overflow: auto; padding: 4px; }
.model-empty { padding: 16px 10px; color: #94a3b8; font-size: 12px; text-align: center; }
.model-option {
  width: 100%;
  display: grid;
  gap: 1px;
  text-align: left;
  border: 0;
  border-radius: 7px;
  background: transparent;
  padding: 6px 8px;
  cursor: pointer;
}
.model-option:hover,
.model-option.on { background: var(--surface-2); }
.model-id { font-size: 12.5px; color: var(--text); word-break: break-all; }
.model-meta { font-size: 11px; color: #94a3b8; }
</style>

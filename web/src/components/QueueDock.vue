<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Check, ChevronDown, ChevronUp, ListTree, Pencil, Send, Trash2, X } from "lucide-vue-next";
import type { InboxRow } from "../api";

const props = defineProps<{
  rows: InboxRow[];
  running: boolean;
  update: (id: string, action: { kind: "edit"; content: string } | { kind: "remove" } | { kind: "steer" }) => Promise<void>;
}>();

const queue = computed(() => props.rows.filter((row) => row.placement === "queued"));
const collapsed = ref(true);
const editing = ref<{ id: string; text: string } | null>(null);
const busyId = ref<string | null>(null);

watch(queue, (rows) => {
  if (rows.length === 0) collapsed.value = true;
  if (editing.value && !rows.some((row) => row.id === editing.value?.id)) editing.value = null;
});

const interactionActive = computed(() => editing.value !== null || busyId.value !== null);
const expanded = computed(() => !collapsed.value || interactionActive.value);
const listVisible = computed(() => queue.value.length === 1 || expanded.value);

async function apply(id: string, action: { kind: "edit"; content: string } | { kind: "remove" } | { kind: "steer" }) {
  busyId.value = id;
  try {
    await props.update(id, action);
    if (action.kind === "edit") editing.value = null;
  } finally {
    if (busyId.value === id) busyId.value = null;
  }
}

function saveEdit() {
  if (!editing.value || !editing.value.text.trim()) return;
  void apply(editing.value.id, { kind: "edit", content: editing.value.text.trim() });
}
</script>

<template>
  <div v-if="queue.length" class="dock" data-queue-dock>
    <div class="panel">
      <button
        v-if="queue.length > 1"
        type="button"
        class="header"
        :aria-expanded="expanded"
        :disabled="interactionActive"
        @click="collapsed = !collapsed"
      >
        <span class="lead" aria-hidden><ListTree :size="14" /></span>
        <span class="count">{{ queue.length }} 条排队消息</span>
        <span class="chevron" aria-hidden>
          <ChevronDown v-if="expanded" :size="14" />
          <ChevronUp v-else :size="14" />
        </span>
      </button>
      <ul v-show="listVisible" class="list">
        <li v-for="row in queue" :key="row.id" class="row">
          <span v-if="queue.length === 1" class="lead" aria-hidden><ListTree :size="14" /></span>
          <input
            v-if="editing?.id === row.id"
            class="editor"
            aria-label="编辑排队消息"
            :value="editing.text"
            autofocus
            @input="editing = { id: row.id, text: ($event.target as HTMLInputElement).value }"
            @keydown.esc="editing = null"
            @keydown.enter.prevent="saveEdit"
          />
          <span v-else class="preview" :title="row.content">{{ row.preview || row.content }}</span>
          <span v-if="row.referenceKnowledge != null" class="knowledge-choice">{{ row.referenceKnowledge ? '参考知识' : '不参考知识' }}</span>
          <div class="actions">
            <template v-if="editing?.id === row.id">
              <button
                type="button"
                class="action"
                title="保存排队消息"
                :disabled="busyId !== null || !editing.text.trim()"
                @click="saveEdit"
              >
                <Check :size="14" />
              </button>
              <button type="button" class="action" title="取消编辑" :disabled="busyId !== null" @click="editing = null">
                <X :size="14" />
              </button>
            </template>
            <template v-else>
              <button
                type="button"
                class="action"
                title="编辑排队消息"
                :disabled="busyId !== null"
                @click="editing = { id: row.id, text: row.content }"
              >
                <Pencil :size="14" />
              </button>
              <button
                type="button"
                class="action"
                title="删除排队消息"
                :disabled="busyId !== null"
                @click="apply(row.id, { kind: 'remove' })"
              >
                <Trash2 :size="14" />
              </button>
              <button
                type="button"
                class="action send"
                :title="running ? '插话发送' : '仅运行中可插话发送'"
                :disabled="busyId !== null || !running"
                @click="apply(row.id, { kind: 'steer' })"
              >
                <Send :size="13" />
              </button>
            </template>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.knowledge-choice { flex-shrink: 0; color: var(--muted); background: var(--surface-2); padding: 2px 6px; border-radius: 5px; font-size: 11px; }
.dock {
  position: relative;
  z-index: 0;
  margin: 0 10px -1px;
}
.panel {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--line);
  border-bottom: none;
  border-radius: 12px 12px 0 0;
  background: var(--surface-2);
}
.header {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 36px;
  padding: 4px 12px;
  border: 0;
  background: transparent;
  color: var(--text);
  text-align: left;
}
.header:disabled { cursor: default; }
.lead {
  display: grid;
  flex: none;
  place-items: center;
  color: #94a3b8;
}
.count {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 24px;
  color: var(--text);
}
.chevron {
  display: grid;
  place-items: center;
  color: #94a3b8;
}
.list {
  max-height: 180px;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
}
.row {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  padding: 4px 6px 4px 12px;
}
.row + .row { box-shadow: inset 0 1px 0 var(--line); }
.preview,
.editor {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  line-height: 20px;
}
.preview {
  overflow: hidden;
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.editor {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  outline: none;
  background: var(--surface);
  color: var(--text);
}
.editor:focus { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(94, 106, 210, 0.12); }
.actions { display: flex; flex: none; align-items: center; gap: 4px; }
.action {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: #94a3b8;
}
.action:hover:not(:disabled) { background: #e8eaf1; color: #334155; }
.action.send:hover:not(:disabled) { background: var(--blue-soft); color: var(--blue); }
.action:disabled { cursor: default; opacity: 0.4; }
</style>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { api, type SessionEvent } from "../api";
import { toolTitle } from "../toolDisplay";
import { formatDateTime } from "../format";
const props = defineProps<{ open: boolean; sessionId: string; events: SessionEvent[]; selectedId?: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const selected = ref("");
const output = ref("");
const error = ref("");
const loading = ref(false);
const offset = ref(0);
const hasMore = ref(false);
let generation = 0;
const entries = computed(() => props.events.filter((e) => e.type === "tool/result" || e.type === "request/header").map((e) => ({
  id: String(e.data.callId || `request-${e.seq}`),
  label: e.type === "tool/result" ? toolTitle(String(e.data.name || "工具")) : "模型请求快照",
  artifactId: String(e.data.artifactId || e.data.requestArtifactId || ""),
  event: e,
})).filter((e, i, items) => i >= items.length - 100 || e.id === props.selectedId).reverse());
const current = computed(() => entries.value.find((e) => e.id === selected.value));
const call = computed(() => props.events.find((e) => e.type === "tool/call" && e.data.callId === selected.value));
async function load(id: string, append = false) {
  const version = ++generation;
  selected.value = id; error.value = "";
  if (!append) { output.value = ""; offset.value = 0; hasMore.value = false; }
  const item = current.value;
  if (!item) return;
  if (!item.artifactId) { output.value = String(item.event.data.summary || "无附件输出"); return; }
  loading.value = true;
  try {
    const page = await api.artifact(props.sessionId, item.artifactId, offset.value);
    if (version !== generation) return;
    output.value += String(page.text || "");
    offset.value = Number(page.nextOffset ?? offset.value + String(page.text || "").length);
    hasMore.value = page.eof === false;
    if (!append && page.eof && item.label === "模型请求快照") {
      try { output.value = JSON.stringify(JSON.parse(output.value), null, 2); } catch { /* paginated output stays raw */ }
    }
  } catch (e: any) { if (version === generation) error.value = e?.response?.data?.detail || "证据读取失败"; }
  finally { if (version === generation) loading.value = false; }
}
watch(() => props.open, async (open) => {
  await nextTick();
  if (open) { if (!dialog.value?.open) dialog.value?.showModal(); void load(props.selectedId || entries.value[0]?.id || ""); }
  else dialog.value?.close();
});
watch(() => props.selectedId, (id) => { if (props.open && id) void load(id); });
</script>
<template>
  <dialog ref="dialog" class="evidence-panel" @close="emit('close')" @click="(e) => { if (e.target === dialog) emit('close'); }">
    <header><div><strong>执行证据</strong><p>现场工具输出与模型请求快照 · 敏感内容已脱敏</p></div><button class="btn small" aria-label="关闭证据面板" @click="emit('close')">关闭</button></header>
    <div class="evidence-layout">
      <nav aria-label="证据列表"><button v-for="item in entries" :key="item.id" :class="{ selected: selected === item.id }" @click="load(item.id)">{{ item.label }}<small>{{ item.id.slice(0, 18) }}</small></button><p v-if="!entries.length">暂无执行证据</p></nav>
      <article>
        <p v-if="current" class="meta">{{ current.label }} · {{ current.event.createdAt ? formatDateTime(current.event.createdAt) : '' }}<br>{{ current.id }}</p>
        <details v-if="call"><summary>调用参数与查询范围</summary><pre>{{ JSON.stringify(call.data.arguments, null, 2) }}</pre></details>
        <p v-if="error" role="alert">{{ error }}</p>
        <pre v-if="output" class="output">{{ output }}</pre>
        <p v-if="loading" role="status">正在读取…</p>
        <button v-if="hasMore" class="btn" :disabled="loading" @click="load(selected, true)">继续读取后续内容</button>
      </article>
    </div>
  </dialog>
</template>
<style scoped>
.evidence-panel { position: fixed; inset: 0 0 0 auto; margin: 0; width: min(850px, 95vw); max-width: 95vw; height: 100dvh; max-height: 100dvh; padding: 0; border: 0; border-left: 1px solid var(--line); background: var(--surface); color: var(--text); }
.evidence-panel::backdrop { background: #10182860; }
header { display: flex; justify-content: space-between; align-items: center; padding: 20px; border-bottom: 1px solid var(--line); }
header p, .meta { color: var(--muted); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.evidence-layout { display: grid; grid-template-columns: 170px 1fr; height: calc(100% - 100px); }
nav { padding: 12px; overflow: auto; border-right: 1px solid var(--line); } nav button { width: 100%; padding: 10px; margin-bottom: 6px; text-align: left; border: 0; border-radius: 8px; color: var(--text); background: transparent; cursor: pointer; }
nav button.selected { background: var(--blue-soft); color: var(--blue); } small { display: block; margin-top: 5px; font-size: 10px; overflow-wrap: anywhere; }
article { min-width: 0; padding: 16px; overflow: auto; } pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.7 monospace; background: var(--surface-2); padding: 12px; border-radius: 8px; } summary { cursor: pointer; font-size: 12px; }
@media(max-width:600px) { .evidence-layout { grid-template-columns: 110px 1fr; } nav { padding: 6px; } article { padding: 10px; } }
</style>

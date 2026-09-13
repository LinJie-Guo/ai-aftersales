<script setup lang="ts">
import { computed, ref, useId } from "vue";
import { ChevronDown, FileCode2, BookOpen, Terminal, Server, Wrench, Loader2, Check, CircleAlert } from "lucide-vue-next";
import { toolHeadline, toolTitle } from "../toolDisplay";

const props = defineProps<{
  name: string;
  status: "running" | "done" | "error";
  summary?: string;
  args?: Record<string, unknown>;
  expanded?: boolean;
  elapsedMs?: number;
  evidenceId?: string;
}>();
const emit = defineEmits<{ toggle: []; evidence: [id: string] }>();
const detailId = useId();
const fullSections = ref<Record<string, boolean>>({});
const icon = computed(() => {
  if (props.name === "knowledge_search") return BookOpen;
  if (/^(read|grep|glob|code_)/.test(props.name)) return FileCode2;
  if (props.name === "bash") return Terminal;
  if (/^(asset_|artifact_)/.test(props.name)) return Server;
  return Wrench;
});
const title = computed(() => toolTitle(props.name));
const headline = computed(() => toolHeadline(props.name, props.summary, props.args));
const statusLabel = computed(() => ({ running: "执行中", done: "完成", error: "失败" })[props.status]);
const sections = computed(() => {
  const result: Array<{ id: string; label: string; text: string }> = [];
  if (props.args && Object.keys(props.args).length) {
    const { description: _description, command, ...other } = props.args;
    if (typeof command === "string" && command.trim()) result.push({ id: "command", label: "执行命令", text: command.trim() });
    else if (Object.keys(other).length) result.push({ id: "args", label: "调用参数", text: JSON.stringify(other, null, 2) });
  }
  if (props.summary?.trim()) result.push({ id: "result", label: props.status === "error" ? "错误信息" : "输出结果", text: props.summary.trim() });
  return result.map((section) => {
    const preview = section.text.split("\n").slice(0, 12).join("\n").slice(0, 1400);
    return { ...section, preview, truncated: preview.length < section.text.length };
  });
});
const canExpand = computed(() => sections.value.length > 0);
</script>

<template>
  <div class="tool-row" :class="[status, { expanded }]">
    <button type="button" class="tool-row-main" :disabled="!canExpand" :aria-expanded="!!expanded" :aria-controls="detailId" @click="emit('toggle')">
      <span class="tool-icon"><component :is="icon" :size="15" /></span>
      <span class="tool-description"><span class="tool-title">{{ title }}</span><span v-if="headline" class="tool-meta" :title="headline">{{ headline }}</span></span>
      <span v-if="elapsedMs" class="tool-time">{{ (elapsedMs / 1000).toFixed(1) }}s</span>
      <span class="tool-status" :class="status"><Loader2 v-if="status === 'running'" class="spin" :size="12" /><CircleAlert v-else-if="status === 'error'" :size="12" /><Check v-else :size="12" />{{ statusLabel }}</span>
      <ChevronDown v-if="canExpand" class="tool-chevron" :class="{ rotated: expanded }" :size="13" />
    </button>
    <div v-if="expanded && canExpand" :id="detailId" class="tool-detail">
      <button v-if="evidenceId && status !== 'running'" type="button" class="tool-more" @click="emit('evidence', evidenceId)">查看完整证据与来源</button>
      <section v-for="section in sections" :key="section.id" class="tool-section">
        <div class="tool-section-label">{{ section.label }}</div>
        <pre>{{ fullSections[section.id] ? section.text : section.preview }}</pre>
        <button v-if="section.truncated" type="button" class="tool-more" :aria-expanded="!!fullSections[section.id]" @click="fullSections[section.id] = !fullSections[section.id]">{{ fullSections[section.id] ? '收起长内容' : '展开完整内容' }}<ChevronDown :size="12" :class="{ rotated: fullSections[section.id] }" /></button>
      </section>
    </div>
  </div>
</template>

<style scoped>
.tool-row { min-width: 0; border: 1px solid transparent; border-radius: 9px; }
.tool-row.expanded { border-color: var(--line); background: var(--surface-2); }
.tool-row.running { background: color-mix(in srgb, var(--blue-soft) 60%, var(--surface)); }
.tool-row.error { border-color: color-mix(in srgb, var(--red) 20%, var(--line)); }
.tool-row-main { width: 100%; display: flex; align-items: center; gap: 10px; padding: 9px 10px; border: 0; background: transparent; text-align: left; color: var(--text); border-radius: 8px; cursor: pointer; }
.tool-row-main:disabled { cursor: default; }
.tool-row-main:hover:not(:disabled) { background: var(--surface-2); }
.tool-row-main:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
.tool-icon { display: grid; place-items: center; flex: none; width: 22px; height: 24px; color: var(--muted); }
.running .tool-icon { color: var(--blue); }
.tool-description { display: flex; align-items: baseline; gap: 10px; flex: 1; min-width: 0; }
.tool-title { font-size: 12px; font-weight: 600; white-space: nowrap; }
.tool-meta { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.tool-status { display: inline-flex; align-items: center; gap: 4px; flex: none; font-size: 11px; white-space: nowrap; }
.tool-status.done { color: var(--green); }
.tool-status.running { color: var(--blue); }
.tool-status.error { color: var(--red); }
.tool-time { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.tool-chevron { flex: none; color: var(--muted); transition: transform .18s ease; }
.rotated { transform: rotate(180deg); }
.tool-detail { padding: 0 12px 12px 42px; display: grid; gap: 12px; min-width: 0; }
.tool-section { min-width: 0; }
.tool-section-label { font-size: 11px; font-weight: 500; color: var(--muted); margin-bottom: 6px; }
.tool-section pre { margin: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); color: var(--text); font: 12px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.tool-more { display: flex; align-items: center; gap: 4px; padding: 6px 0 0; border: 0; background: transparent; color: var(--blue); font-size: 11px; }
.spin { animation: tool-spin 1.2s linear infinite; }
@keyframes tool-spin { to { transform: rotate(360deg); } }
@media (max-width: 600px) { .tool-description { display: grid; gap: 2px; } .tool-row-main { gap: 6px; padding: 8px 6px; } .tool-detail { padding-left: 10px; } .tool-time { display: none; } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } .tool-chevron { transition: none; } }
</style>

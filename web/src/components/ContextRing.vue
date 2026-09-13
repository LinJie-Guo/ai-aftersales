<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { ContextInfo } from "../api";
import { formatTokens } from "../format";

const props = defineProps<{ info: ContextInfo | null }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

const pct = computed(() => Math.min(Math.round(props.info?.percent ?? 0), 100));
const used = computed(() => num(props.info?.used_tokens ?? props.info?.usedTokens));
const max = computed(() => num(props.info?.max_tokens ?? props.info?.maxTokens));
const systemTokens = computed(() => num(props.info?.system_tokens ?? props.info?.systemTokens));
const toolsTokens = computed(() => num(props.info?.tools_tokens ?? props.info?.toolsTokens));
const messageTokens = computed(() => num(props.info?.message_tokens ?? props.info?.messageTokens));
const cachedTokens = computed(() => num(props.info?.cached_tokens ?? props.info?.cachedTokens));
const promptTokens = computed(() => num(props.info?.prompt_tokens ?? props.info?.promptTokens));
const cacheHit = computed(() => {
  const raw = props.info?.cache_hit_percent ?? props.info?.cacheHitPercent;
  if (raw === null || raw === undefined) return promptTokens.value > 0 ? Math.round((cachedTokens.value / promptTokens.value) * 10) / 10 : null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
});
const breakdownTotal = computed(() => systemTokens.value + toolsTokens.value + messageTokens.value);

const rows = computed(() => [
  { key: "system", label: "系统提示词", tokens: systemTokens.value, color: "system" },
  { key: "tools", label: "工具", tokens: toolsTokens.value, color: "tools" },
  { key: "messages", label: "对话消息", tokens: messageTokens.value, color: "messages" },
]);

const segments = computed(() => {
  if (!props.info || pct.value <= 0) return [];
  if (breakdownTotal.value <= 0) return [{ key: "total", color: "messages", width: pct.value }];
  return rows.value
    .map((row) => ({
      key: row.key,
      color: row.color,
      width: pct.value * (row.tokens / breakdownTotal.value),
    }))
    .filter((row) => row.width > 0);
});

const r = 5.5;
const c = 2 * Math.PI * r;
const dash = computed(() => `${(pct.value / 100) * c} ${c}`);

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function toggle() {
  open.value = !open.value;
}

function onPointerDown(event: PointerEvent) {
  if (event.target instanceof Node && root.value?.contains(event.target)) return;
  open.value = false;
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === "Escape") open.value = false;
}

onMounted(() => {
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("keydown", onKeyDown);
});
onUnmounted(() => {
  document.removeEventListener("pointerdown", onPointerDown);
  document.removeEventListener("keydown", onKeyDown);
});
</script>

<template>
  <span ref="root" class="ctx-root">
    <button
      type="button"
      class="ctx-trigger"
      :aria-label="`上下文已用 ${pct}%`"
      :aria-expanded="open"
      @click="toggle"
    >
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
        <circle class="ctx-track" cx="7" cy="7" :r="r" />
        <circle
          class="ctx-fill"
          cx="7" cy="7" :r="r"
          :stroke-dasharray="dash"
          transform="rotate(-90 7 7)"
        />
      </svg>
    </button>
    <div v-if="open" class="ctx-panel" role="dialog" aria-label="上下文已用">
      <div class="ctx-header">
        <span class="ctx-headline">上下文已用</span>
        <span class="ctx-percent">{{ pct }}%</span>
        <span class="ctx-figures">~{{ formatTokens(used) }} / {{ formatTokens(max || 0) }}</span>
      </div>
      <div class="ctx-bar">
        <div
          v-for="seg in segments"
          :key="seg.key"
          class="ctx-seg"
          :class="seg.color"
          :style="{ width: `${seg.width}%` }"
        />
      </div>
      <dl class="ctx-rows">
        <div v-for="row in rows" :key="row.key" class="ctx-row">
          <dt><span class="ctx-swatch" :class="row.color" />{{ row.label }}</dt>
          <dd>~{{ formatTokens(row.tokens) }}</dd>
        </div>
        <div class="ctx-row">
          <dt>缓存命中</dt>
          <dd v-if="cacheHit !== null">{{ cacheHit }}% · {{ formatTokens(cachedTokens) }}</dd>
          <dd v-else>—</dd>
        </div>
      </dl>
    </div>
  </span>
</template>

<style scoped>
.ctx-root { position: relative; display: inline-flex; }
.ctx-trigger {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  cursor: pointer;
  color: #8b8b8b;
}
.ctx-trigger:hover { background: rgba(0, 0, 0, 0.05); }
.ctx-track { fill: none; stroke: #e5e5e5; stroke-width: 2; }
.ctx-fill { fill: none; stroke: #8b8b8b; stroke-width: 2; stroke-linecap: round; }

.ctx-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 80;
  box-sizing: border-box;
  width: 264px;
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: #2a2a2e;
  color: #d4d4d8;
  font-size: 12px;
  line-height: 20px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
}
.ctx-header { display: flex; align-items: center; gap: 6px; white-space: nowrap; min-width: 0; }
.ctx-headline { color: #a1a1aa; }
.ctx-percent { font-weight: 500; color: #f4f4f5; }
.ctx-figures { margin-left: auto; flex-shrink: 0; font-weight: 500; font-variant-numeric: tabular-nums; color: #f4f4f5; }
.ctx-bar {
  display: flex;
  gap: 1px;
  margin: 10px 0 12px;
  height: 4px;
  border-radius: 999px;
  background: #3f3f46;
  overflow: hidden;
}
.ctx-seg { flex: none; min-width: 2px; height: 100%; border-radius: 1px; }
.ctx-seg.system, .ctx-swatch.system { background: #9aa3b2; }
.ctx-seg.tools, .ctx-swatch.tools { background: rgb(167, 139, 250); }
.ctx-seg.messages, .ctx-swatch.messages { background: #4f8cff; }
.ctx-rows { margin: 6px 0 0; }
.ctx-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 0;
}
.ctx-row dt { color: #a1a1aa; }
.ctx-row dd { margin: 0; font-variant-numeric: tabular-nums; color: #f4f4f5; }
.ctx-swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 2px;
  vertical-align: baseline;
}
</style>

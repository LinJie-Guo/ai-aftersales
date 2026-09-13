<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { ChevronDown, Sparkles, Loader2, Clock3 } from "lucide-vue-next";

const props = withDefaults(defineProps<{
  elapsedMs?: number;
  toolCount?: number;
  open?: boolean;
  live?: boolean;
  currentStep?: string;
}>(), { open: false, live: false, toolCount: 0 });

const expanded = ref(props.open);
const bodyId = useId();
watch(() => props.open, (value) => { expanded.value = value; });
watch(() => props.live, (value) => { if (!value) expanded.value = false; });
const elapsed = computed(() => {
  if (!props.elapsedMs || props.elapsedMs < 1000) return "";
  const seconds = Math.floor(props.elapsedMs / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
});
</script>

<template>
  <section class="think-process" :class="{ live, open: expanded }" aria-label="思考过程">
    <button type="button" class="think-toggle" :aria-expanded="expanded" :aria-controls="bodyId" @click="expanded = !expanded">
      <span class="think-mark"><Loader2 v-if="live" :size="15" class="spin" /><Sparkles v-else :size="15" /></span>
      <span class="think-heading">{{ live ? '正在分析' : '思考过程' }}</span>
      <span v-if="toolCount" class="think-count">{{ toolCount }} 次工具调用</span>
      <span v-if="elapsed" class="think-time"><Clock3 :size="12" />{{ elapsed }}</span>
      <span class="think-action">{{ expanded ? '收起' : '查看详情' }}<ChevronDown :size="14" :class="{ rotated: expanded }" /></span>
    </button>
    <div v-if="live && currentStep" class="think-current" role="status"><span class="activity-dot" />{{ currentStep }}</div>
    <div v-if="expanded" :id="bodyId" class="think-body"><div class="think-timeline"><slot /></div></div>
  </section>
</template>

<style scoped>
.think-process { width: 100%; min-width: 0; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); overflow: hidden; }
.think-process.live { border-color: color-mix(in srgb, var(--blue) 28%, var(--line)); }
.think-toggle { width: 100%; min-height: 52px; display: flex; align-items: center; gap: 10px; padding: 12px 16px; border: 0; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.think-toggle:hover { background: var(--surface-2); }
.think-toggle:focus-visible { outline: 2px solid var(--blue); outline-offset: -3px; border-radius: 11px; }
.think-mark { display: grid; place-items: center; width: 26px; height: 26px; flex: none; border-radius: 8px; background: var(--blue-soft); color: var(--blue); }
.think-heading { font-size: 13px; font-weight: 600; white-space: nowrap; }
.think-count { color: var(--muted); font-size: 12px; padding-left: 10px; border-left: 1px solid var(--line); }
.think-time { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.think-action { margin-left: auto; display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; white-space: nowrap; }
.think-action svg { transition: transform .18s ease; }
.think-action .rotated { transform: rotate(180deg); }
.think-body { padding: 0 16px 16px 28px; }
.think-timeline { display: grid; gap: 8px; padding: 2px 0 0 17px; border-left: 1px solid var(--line); min-width: 0; }
.think-timeline :deep(.think-prose) { margin: 0; padding: 3px 10px; color: var(--muted); font-size: 12.5px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
.think-current { display: flex; align-items: center; gap: 7px; margin: -3px 16px 13px 52px; color: var(--muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.activity-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--blue); flex: none; }
.spin { animation: think-spin 1.5s linear infinite; }
@keyframes think-spin { to { transform: rotate(360deg); } }
@media (max-width: 600px) {
  .think-toggle { gap: 7px; padding: 10px 12px; flex-wrap: wrap; }
  .think-count { border: 0; padding-left: 0; font-size: 11px; }
  .think-time { font-size: 11px; }
  .think-action { font-size: 0; gap: 0; }
  .think-body { padding: 0 10px 12px 24px; }
  .think-timeline { padding-left: 10px; }
}
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } .think-action svg { transition: none; } }
</style>

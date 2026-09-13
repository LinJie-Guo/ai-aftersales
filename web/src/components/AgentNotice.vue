<script setup lang="ts">
import { computed } from "vue";
import { CircleAlert, FileClock, ChevronRight } from "lucide-vue-next";
import { messageNotice } from "../messageNotice";
const props = defineProps<{ content: string; actionable?: boolean; busy?: boolean }>();
const emit = defineEmits<{ retry: []; evidence: [] }>();
const notice = computed(() => messageNotice(props.content));
</script>

<template>
  <section v-if="notice" class="agent-notice" :class="notice.kind" role="status">
    <div class="notice-icon"><FileClock v-if="notice.kind === 'partial'" :size="18" /><CircleAlert v-else :size="18" /></div>
    <div class="notice-content">
      <h4>{{ notice.title }}</h4>
      <p>{{ notice.detail }}</p>
      <p class="notice-hint">{{ notice.hint }}</p>
      <div v-if="actionable" class="notice-actions">
        <button type="button" class="btn small" :disabled="busy" @click="emit('retry')">沿用证据继续</button>
        <button type="button" class="btn small" @click="emit('evidence')">查看执行证据</button>
        <span>也可在输入框切换模型后继续。</span>
      </div>
      <details v-if="notice.technical" class="notice-details">
        <summary><ChevronRight :size="13" />{{ notice.kind === 'partial' ? '查看原始执行摘要' : '查看错误详情' }}</summary>
        <pre>{{ notice.technical }}</pre>
      </details>
    </div>
  </section>
</template>

<style scoped>
.agent-notice { display: flex; align-items: flex-start; gap: 12px; padding: 16px 18px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; min-width: 0; color: var(--text); }
.notice-icon { display: grid; place-items: center; width: 32px; height: 32px; flex: 0 0 32px; border-radius: 9px; color: var(--amber); background: var(--amber-soft); }
.partial .notice-icon { color: var(--blue); background: var(--blue-soft); }
.error .notice-icon { color: var(--red); background: var(--red-soft); }
.notice-content { flex: 1; min-width: 0; padding-top: 2px; }
h4 { font-size: 14px; line-height: 1.6; font-weight: 600; margin: 0 0 5px; }
p { margin: 0; font-size: 13px; line-height: 1.75; overflow-wrap: anywhere; }
.notice-hint { color: var(--muted); margin-top: 4px; font-size: 12px; }
.notice-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.notice-actions span { font-size: 12px; color: var(--muted); }
.notice-details { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 10px; }
summary { display: flex; gap: 5px; align-items: center; width: fit-content; cursor: pointer; font-size: 12px; color: var(--muted); list-style: none; }
summary::-webkit-details-marker { display: none; }
summary:hover { color: var(--text); }
summary:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; border-radius: 3px; }
details[open] summary svg { transform: rotate(90deg); }
pre { margin: 10px 0 0; padding: 12px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.65; font-family: var(--font-mono, monospace); }
@media(max-width:600px) { .agent-notice { padding: 14px; gap: 10px; } }
</style>

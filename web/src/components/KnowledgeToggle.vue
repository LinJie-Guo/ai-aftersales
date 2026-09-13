<script setup lang="ts">
import { BookOpen } from "lucide-vue-next";
defineProps<{ modelValue: boolean }>();
defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>
<template>
  <label class="knowledge-toggle" :class="{ selected: modelValue }" title="发送时固定本轮选择。关闭后不再检索或自动注入历史知识；已有对话保留。不同选项的插话会排队为下一轮。">
    <input type="checkbox" :checked="modelValue" @change="$emit('update:modelValue', ($event.target as HTMLInputElement).checked)" />
    <BookOpen :size="14" /><span>参考历史知识</span>
  </label>
</template>
<style scoped>
.knowledge-toggle { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); background: var(--surface); font-size: 12px; cursor: pointer; user-select: none; white-space: nowrap; }
.knowledge-toggle:hover { border-color: var(--line-strong); color: var(--text); }
.knowledge-toggle.selected { color: var(--blue); border-color: var(--blue); background: var(--blue-soft); }
.knowledge-toggle input { appearance: auto; margin: 0; width: 13px; height: 13px; accent-color: var(--blue); cursor: pointer; }
.knowledge-toggle:focus-within { outline: 2px solid var(--blue); outline-offset: 2px; }
</style>

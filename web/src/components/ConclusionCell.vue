<script setup lang="ts">
import { ref } from "vue";
import { renderMarkdown } from "../markdown";

defineProps<{ text?: string | null }>();

const show = ref(false);
const pos = ref({ top: 0, left: 0 });

function plainPreview(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "[图片]")
    .replace(/\[([^\]]*)]\([^)]+\)/g, "$1")
    .replace(/[#*`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function openTip(e: MouseEvent, text?: string | null) {
  if (!text?.trim()) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const width = Math.min(420, window.innerWidth - 24);
  let left = rect.left;
  if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12;
  pos.value = { top: rect.bottom + 8, left: Math.max(12, left) };
  show.value = true;
}

function closeTip() {
  show.value = false;
}
</script>

<template>
  <td
    class="conclusion-cell muted"
    @mouseenter="openTip($event, text)"
    @mouseleave="closeTip"
    @click.stop
  >
    <span class="conclusion-preview">{{ text?.trim() ? plainPreview(text) : "-" }}</span>
    <Teleport to="body">
      <div
        v-if="show && text?.trim()"
        class="conclusion-popover md-body"
        :style="{ top: `${pos.top}px`, left: `${pos.left}px` }"
        @mouseenter="show = true"
        @mouseleave="closeTip"
        v-html="renderMarkdown(text)"
      ></div>
    </Teleport>
  </td>
</template>

<style scoped>
.conclusion-cell {
  position: relative;
  max-width: 240px;
  width: 240px;
}
.conclusion-preview {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

<style>
.conclusion-popover {
  position: fixed;
  z-index: 80;
  width: min(420px, calc(100vw - 24px));
  max-height: min(360px, calc(100vh - 120px));
  overflow: auto;
  padding: 12px 14px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.14);
  font-size: 13px;
  line-height: 1.6;
  pointer-events: auto;
}
.conclusion-popover .md-h3,
.conclusion-popover .md-h4 { margin: 8px 0 4px; font-size: 14px; }
.conclusion-popover .md-p { margin: 4px 0; }
.conclusion-popover .md-ul { margin: 4px 0; padding-left: 18px; }
</style>

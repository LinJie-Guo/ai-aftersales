<script setup lang="ts">
import { ref } from "vue";
import { CircleAlert } from "lucide-vue-next";

defineProps<{ tip: string }>();

const show = ref(false);
const pos = ref({ top: 0, left: 0 });
const iconRef = ref<HTMLElement | null>(null);

function open() {
  const el = iconRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  pos.value = { top: r.top - 8, left: r.left + r.width / 2 };
  show.value = true;
}
function close() {
  show.value = false;
}
</script>

<template>
  <span
    ref="iconRef"
    class="field-hint-icon"
    @mouseenter="open"
    @mouseleave="close"
    @focus="open"
    @blur="close"
    tabindex="0"
    role="button"
    aria-label="字段说明"
  >
    <CircleAlert :size="14" />
  </span>
  <Teleport to="body">
    <div
      v-if="show"
      class="field-hint-pop"
      :style="{ top: pos.top + 'px', left: pos.left + 'px' }"
      @mouseenter="show = true"
      @mouseleave="close"
    >
      {{ tip }}
    </div>
  </Teleport>
</template>

<style scoped>
.field-hint-icon {
  display: inline-flex;
  align-items: center;
  color: #f59e0b;
  cursor: help;
  outline: none;
}
.field-hint-icon:hover,
.field-hint-icon:focus { color: #d97706; }
</style>

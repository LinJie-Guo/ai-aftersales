<script setup lang="ts">
import { ref } from "vue";
import { Input } from "ant-design-vue";
import { EyeInvisibleOutlined, EyeOutlined } from "@ant-design/icons-vue";

defineProps<{
  value?: string;
  rows?: number;
  placeholder?: string;
}>();
const emit = defineEmits<{ "update:value": [string] }>();
const show = ref(false);
</script>

<template>
  <div class="secret-box" :class="{ masked: !show }">
    <Input.TextArea
      :value="value"
      class="mono"
      :rows="rows ?? 4"
      :placeholder="placeholder"
      autocomplete="off"
      spellcheck="false"
      name="secret_blob"
      @update:value="emit('update:value', $event)"
    />
    <button type="button" class="reveal" :title="show ? '隐藏密钥' : '显示密钥'" @click="show = !show">
      <EyeOutlined v-if="show" />
      <EyeInvisibleOutlined v-else />
    </button>
  </div>
</template>

<style scoped>
.secret-box { position: relative; }
.secret-box.masked :deep(textarea) { -webkit-text-security: disc; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.reveal {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1;
  display: inline-flex;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--muted, #64748b);
  cursor: pointer;
}
.reveal:hover { color: var(--text, #222); }
</style>

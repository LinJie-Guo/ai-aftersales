<script setup lang="ts">
import { ref } from "vue";
import { api } from "../api";
import { hasPerm } from "../auth";
const props = defineProps<{ sessionId: string; request: { id: string; tool: string; command: string; target: string; expiresAt: string } }>();
const emit = defineEmits<{ resolved: [] }>();
const busy = ref(false);
const error = ref("");
const canApprove = hasPerm("customers.ssh");
async function answer(approved: boolean) {
  busy.value = true; error.value = "";
  try { await api.approveCommand(props.sessionId, props.request.id, approved); emit("resolved"); }
  catch (e: any) { error.value = e?.response?.data?.detail || "审批失败或已过期，请刷新状态"; }
  finally { busy.value = false; }
}
</script>
<template>
  <section class="approval" role="region" aria-label="远程命令审批">
    <strong>等待确认远程操作</strong>
    <p>目标：<code>{{ request.target }}</code> · {{ request.tool }}</p>
    <pre>{{ request.command }}</pre>
    <p class="hint">仅批准下方这一条操作，不授予后续命令权限。请确认目标、命令及其影响；5 分钟内有效。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!canApprove" class="hint">当前账号没有远程操作审批权限，请有权限的人员确认。</p>
    <div class="actions"><button class="btn" :disabled="busy || !canApprove" @click="answer(false)">拒绝</button><button class="btn primary" :disabled="busy || !canApprove" @click="answer(true)">批准本次执行</button></div>
  </section>
</template>
<style scoped>
.approval { border: 1px solid var(--amber); border-radius: 12px; padding: 16px; background: var(--surface); margin: 12px 0; }
strong { font-size: 14px; } p { font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface-2); border: 1px solid var(--line); padding: 12px; border-radius: 8px; font: 12px/1.7 monospace; }
.hint { color: var(--muted); } .error { color: var(--red); } .actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>

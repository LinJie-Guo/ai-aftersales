<script setup lang="ts">
import { ref } from "vue";
import ThinkingProcess from "../src/components/ThinkingProcess.vue";
import ToolCallRow from "../src/components/ToolCallRow.vue";
import AgentNotice from "../src/components/AgentNotice.vue";
import KnowledgeToggle from "../src/components/KnowledgeToggle.vue";
const referenceKnowledge = ref(false), sentChoices = ref<boolean[]>([]);
const live = ref(false), narrow = ref(false), dark = ref(false);
const expanded = ref<Record<string, boolean>>({ last: true });
const long = Array.from({ length: 40 }, (_, i) => `service-${i + 1}  healthy  检查完成`).join("\n");
function toggleTheme() { dark.value = !dark.value; document.documentElement.classList.toggle("dark", dark.value); }
</script>
<template>
  <main class="preview">
    <nav><strong>组件验收</strong><button @click="live = !live">切换运行状态</button><button @click="toggleTheme">切换深色</button><button @click="narrow = !narrow">切换窄屏</button></nav>
    <div class="stage" :class="{ narrow }">
      <section class="option-preview"><strong>新建排查 · 历史经验</strong><KnowledgeToggle v-model="referenceKnowledge" /><small>可选参考相似工单；实时数据仍以现场查询为准。</small></section>
      <section class="option-preview"><strong>聊天输入框 · 发送时固定选择</strong><div class="option-bar"><span>允许环境</span><KnowledgeToggle v-model="referenceKnowledge" /><button class="btn" @click="sentChoices.push(referenceKnowledge)">发送样例（不调用接口）</button></div><small v-for="(choice, i) in sentChoices" :key="i">第 {{ i + 1 }} 轮：{{ choice ? '参考历史知识' : '不参考历史知识' }}</small></section>
      <div class="question">我们知识库现在有多少漏洞数？</div>
      <AgentNotice content="模型请求失败：当前模型限流或额度用尽，请稍后再试，或换一个模型。" />
      <AgentNotice content="本轮工具已经查到结果，模型没有写成结论，先据实汇总如下：
【bash】
{&quot;error&quot;:{&quot;type&quot;:&quot;security_exception&quot;,&quot;reason&quot;:&quot;missing authentication credentials&quot;},&quot;status&quot;:401}
[Artifact demo-result，可用 artifact_read 分页读取]" />
      <AgentNotice content="模型请求失败：502 {&quot;error&quot;:&quot;upstream unavailable&quot;}" />
      <ThinkingProcess :tool-count="3" :elapsed-ms="12400" :open="true" :live="live" current-step="正在读取现场配置">
        <p class="think-prose">先确认知识库的数据来源，再核对统计口径。</p>
        <ToolCallRow name="bash" status="done" :args="{ description: '查看现场目录结构', command: 'ls /opt/service' }" summary="app  config  logs" :expanded="expanded.first" @toggle="expanded.first = !expanded.first" />
        <ToolCallRow name="knowledge_search" status="done" :args="{ query: '知识库 · 漏洞数统计' }" summary="找到 2 条相关知识" :expanded="expanded.knowledge" @toggle="expanded.knowledge = !expanded.knowledge" />
        <p class="think-prose">已找到相关服务，继续检查配置与数据表。</p>
        <ToolCallRow name="bash" :status="live ? 'running' : 'done'" :args="{ description: '查看现场配置', command: 'find /opt/service -maxdepth 2 -name compose.yml' }" :summary="live ? undefined : '/opt/service/config/compose.yml'" :elapsed-ms="1800" :expanded="expanded.last" @toggle="expanded.last = !expanded.last" />
      </ThinkingProcess>
      <div class="answer"><span>排查助手</span><div class="bubble">已确认数据来源。接下来按有效漏洞条目去重统计，并注明统计范围。</div></div>
      <ThinkingProcess :tool-count="1" :elapsed-ms="4800"><ToolCallRow name="read" status="done" :args="{ file_path: 'logs/status.log' }" :summary="long" :expanded="expanded.long" @toggle="expanded.long = !expanded.long" /></ThinkingProcess>
      <ThinkingProcess :tool-count="1" :open="true"><ToolCallRow name="bash" status="error" :args="{ description: '检查服务连接', command: 'curl --max-time 5 http://service/health' }" summary="连接超时，请检查服务状态。" :expanded="expanded.error" @toggle="expanded.error = !expanded.error" /></ThinkingProcess>
    </div>
  </main>
</template>
<style scoped>
.preview { padding: 28px; max-width: 1100px; margin: auto; }
.option-preview { display: grid; justify-items: start; gap: 10px; padding: 18px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; font-size: 13px; }
.option-preview small { color: var(--muted); }.option-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
nav { display: flex; align-items: center; gap: 10px; margin-bottom: 32px; flex-wrap: wrap; }
nav strong { margin-right: auto; } nav button { padding: 7px 12px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); color: var(--text); font-size: 12px; }
.stage { display: grid; gap: 18px; max-width: 920px; margin: auto; }.stage.narrow { width: 360px; max-width: 100%; }
.question { justify-self: end; padding: 14px 18px; background: var(--blue); color: white; border-radius: 12px; font-size: 14px; }
.answer { display: grid; gap: 8px; }.answer > span { font-size: 12px; color: var(--muted); }.bubble { font-size: 14px; }
@media(max-width:600px) { .preview { padding: 14px; } }
</style>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { AutoComplete, Button, Card, Form, FormItem, Input, Space, Select, Modal } from "ant-design-vue";
import { EyeInvisibleOutlined, EyeOutlined, ReloadOutlined } from "@ant-design/icons-vue";
import { api } from "../api";
import { notify } from "../toast";

const testing = ref(false);
const saving = ref(false);
const loadingModels = ref(false);
const showKey = ref(false);
const locked = ref({ url: true, key: true, model: true });
const testResult = ref<{ ok: boolean; message: string } | null>(null);
const catalog = ref<{ id: string; name: string; contextWindow?: number; context_window?: number }[]>([]);
const imageSupport = ref<"auto" | "yes" | "no">("auto");
const capabilities = ref<Record<string, unknown>>({});
const model = ref({
  model_name: "",
  base_url: "",
  api_key: "",
});
watch(model, () => { testResult.value = null; }, { deep: true });

function windowLabel(n?: number) {
  if (!n) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

const modelOptions = computed(() => {
  const q = model.value.model_name.trim();
  const opts = catalog.value.map((item) => {
    const win = windowLabel(item.contextWindow || item.context_window);
    const base = item.name && item.name !== item.id ? `${item.id} · ${item.name}` : item.id;
    return { value: item.id, label: win ? `${base} · ${win}` : base };
  });
  if (q && !opts.some((item) => item.value === q)) {
    opts.unshift({ value: q, label: `使用自定义：${q}` });
  }
  return opts;
});

function filterModel(input: string, option?: { value?: string; label?: string }) {
  const q = input.toLowerCase();
  return `${option?.value || ""} ${option?.label || ""}`.toLowerCase().includes(q);
}

function onModelFocus() {
  locked.value.model = false;
  if (!catalog.value.length) void loadModels(false);
}

onMounted(async () => {
  const m = await api.modelConfig();
  if (m) {
    capabilities.value = m.capabilities || {};
    imageSupport.value = m.capabilities?.image_input === true ? "yes" : m.capabilities?.image_input === false ? "no" : "auto";
    model.value = {
      model_name: m.model_name || m.modelName || "",
      base_url: m.base_url || m.baseUrl || "",
      api_key: m.api_key || m.apiKey || "",
    };
  }
  if (model.value.base_url) await loadModels(false);
});

function payload() {
  const nextCapabilities = { ...capabilities.value };
  if (imageSupport.value === "auto") delete nextCapabilities.image_input;
  else nextCapabilities.image_input = imageSupport.value === "yes";
  return {
    provider: "openai_compatible",
    model_name: model.value.model_name,
    base_url: model.value.base_url,
    api_key: model.value.api_key,
    capabilities: nextCapabilities,
  };
}

async function loadModels(notifyOk = true) {
  loadingModels.value = true;
  try {
    const res = await api.listProviderModels({
      base_url: model.value.base_url,
      api_key: model.value.api_key,
    });
    catalog.value = res.items || [];
    if (!catalog.value.length) {
      if (notifyOk) notify.warning("该服务商没有返回可用模型");
      return;
    }
    if (notifyOk) notify.success(`已加载 ${catalog.value.length} 个模型`);
  } catch (e: any) {
    if (notifyOk) notify.error(e?.response?.data?.detail || "加载模型列表失败");
  } finally {
    loadingModels.value = false;
  }
}

async function saveModel() {
  saving.value = true;
  try {
    const saved = await api.saveModelConfig(payload());
    const win = windowLabel(Number(saved.max_context || saved.maxContext) || undefined);
    notify.success(win ? `模型已保存，上下文窗口 ${win}` : "模型配置已保存");
  } catch (e: any) { notify.error(e?.response?.data?.message || e?.response?.data?.detail || "保存失败，请检查网络后重试"); }
  finally { saving.value = false; }
}

async function testModel() {
  testing.value = true;
  testResult.value = null;
  try {
    const r = await api.testModelConfig(payload());
    testResult.value = r;
  } catch (e: any) {
    testResult.value = { ok: false, message: e?.code === "ECONNABORTED" ? "测试请求超时，请检查网络后重试。" : e?.response?.data?.message || e?.response?.data?.detail || "测试请求失败，请检查网络或登录状态后重试。" };
  } finally {
    testing.value = false;
    if (testResult.value) {
      const show = testResult.value.ok ? Modal.success : Modal.error;
      show({ title: testResult.value.ok ? "模型连接正常" : "模型连接失败", content: testResult.value.message, okText: "知道了" });
    }
  }
}
</script>

<template>
  <Card title="系统设置" size="small">
    <Form
      :disabled="testing || saving"
      autocomplete="off"
      :label-col="{ span: 3 }"
      :wrapper-col="{ span: 10 }"
      style="max-width: 760px"
    >
      <div class="autofill-trap" aria-hidden="true">
        <input type="text" tabindex="-1" autocomplete="username" />
        <input type="password" tabindex="-1" autocomplete="current-password" />
      </div>
      <FormItem label="API 地址">
        <Input
          v-model:value="model.base_url"
          class="mono"
          name="llm_base_url"
          autocomplete="off"
          spellcheck="false"
          :readonly="locked.url"
          placeholder="https://openrouter.ai/api/v1"
          @focus="locked.url = false"
        />
      </FormItem>
      <FormItem label="API 密钥">
        <div class="key-field" :class="{ masked: !showKey }">
          <Input
            v-model:value="model.api_key"
            class="mono"
            type="text"
            name="llm_provider_secret"
            autocomplete="off"
            spellcheck="false"
            :readonly="locked.key"
            placeholder="已保存时显示 ******，输入新密钥可替换"
            @focus="locked.key = false"
          >
            <template #suffix>
              <button type="button" class="reveal" tabindex="-1" :title="showKey ? '隐藏密钥' : '显示密钥'" @click="showKey = !showKey">
                <EyeOutlined v-if="showKey" />
                <EyeInvisibleOutlined v-else />
              </button>
            </template>
          </Input>
        </div>
      </FormItem>
      <FormItem label="模型">
        <Select v-model:value="imageSupport" style="width: 100%; margin-bottom: 8px" :options="[{ value: 'auto', label: '图片能力：自动检测' }, { value: 'yes', label: '支持图片' }, { value: 'no', label: '仅文本（图片请求将提示切换模型）' }]" />
        <Space.Compact style="width: 100%">
          <AutoComplete
            v-model:value="model.model_name"
            class="mono"
            name="llm_model_id"
            autocomplete="off"
            allow-clear
            :options="modelOptions"
            :filter-option="filterModel"
            :disabled="testing || saving"
            placeholder="搜索列表，或直接输入模型 ID"
            style="width: calc(100% - 40px)"
            @focus="onModelFocus"
          />
          <Button :loading="loadingModels" @click="loadModels()"><ReloadOutlined /></Button>
        </Space.Compact>
      </FormItem>
      <FormItem :wrapper-col="{ offset: 3 }">
        <Space>
          <Button type="primary" :loading="saving" @click="saveModel">保存</Button>
          <Button :loading="testing" @click="testModel">{{ testing ? "测试中…" : "测试连接" }}</Button>
        </Space>
        <div class="test-hint">测试当前填写的配置，不会自动保存；最长等待 20 秒。</div>
      </FormItem>
      <FormItem v-if="testResult" :wrapper-col="{ offset: 3 }">
        <div class="test-result" role="status" aria-live="polite" :class="testResult.ok ? 'ok' : 'err'">
          {{ testResult.ok ? "连接正常：" : "连接失败：" }}{{ testResult.message }}
        </div>
      </FormItem>
    </Form>
  </Card>
</template>

<style scoped>
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.autofill-trap {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
}
.key-field.masked :deep(input) { -webkit-text-security: disc; }
.reveal {
  display: inline-flex;
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.test-result { padding: 10px 12px; border-radius: 8px; font-size: 13px; line-height: 1.6; }
.test-hint { margin-top: 8px; color: #6b7280; font-size: 12px; line-height: 1.6; }
.test-result.ok { color: #047857; background: #ecfdf5; }
.test-result.err { color: #b91c1c; background: #fef2f2; }
</style>

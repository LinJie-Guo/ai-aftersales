<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { Bot, User, Lock, LogIn } from "lucide-vue-next";
import { api } from "../api";
import { firstAllowedPath, persistSession } from "../auth";
import { notify } from "../toast";

const router = useRouter();
const username = ref("admin");
const password = ref("");
const loading = ref(false);

async function submit() {
  if (!username.value || !password.value) return notify.warning("请输入用户名和密码");
  loading.value = true;
  try {
    const { data } = await api.login(username.value, password.value);
    localStorage.setItem("token", data.access_token);
    persistSession(data);
    notify.success("登录成功");
    router.replace((router.currentRoute.value.query.redirect as string) || firstAllowedPath());
  } catch (e: any) {
    notify.error(e?.response?.data?.detail || "登录失败，请检查用户名或密码");
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-hero">
      <div class="login-hero-inner">
        <div class="brand" style="color:#fff; font-size:20px">
          <span class="brand-mark"><Bot :size="22" /></span>
          <span>AI 售后中枢</span>
        </div>
        <h1>让每一次售后排查<br />都有 AI 一起看代码</h1>
        <p>基于客户代码、环境与数据结构的多轮智能排查，沉淀可复用的售后知识。</p>
        <ul class="login-points">
          <li>客户交付实例 · 代码/分支/数据结构统一管理</li>
          <li>AI 工作区 · 多轮追问，支持截图与日志</li>
          <li>知识沉淀 · 相似问题一键检索复用</li>
        </ul>
      </div>
    </div>

    <div class="login-form-wrap">
      <form class="login-card" @submit.prevent="submit">
        <h2>登录</h2>
        <p class="panel-sub">请输入账号登录 AI 售后系统</p>
        <div class="field" style="margin-top:18px">
          <label>用户名</label>
          <div class="input-icon">
            <User :size="16" />
            <input v-model="username" placeholder="admin" autocomplete="username" />
          </div>
        </div>
        <div class="field" style="margin-top:14px">
          <label>密码</label>
          <div class="input-icon">
            <Lock :size="16" />
            <input v-model="password" type="password" placeholder="请输入密码" autocomplete="current-password" />
          </div>
        </div>
        <button class="btn primary" type="submit" :disabled="loading" style="width:100%; margin-top:22px; min-height:42px">
          <LogIn :size="16" />{{ loading ? "登录中…" : "登录" }}
        </button>
        <p class="login-tip">默认管理员账号：<b>admin</b> / <b>admin123</b>（可在系统设置中修改）</p>
      </form>
    </div>
  </div>
</template>

<style scoped>
.login-page { min-height: 100vh; display: grid; grid-template-columns: 1.05fr 1fr; background: var(--bg); }
.login-hero { background: #111113; color: #fff; display: grid; place-items: center; padding: 48px; }
.login-hero-inner { max-width: 440px; display: grid; gap: 18px; }
.login-hero-inner .brand-mark { background: var(--blue); box-shadow: none; }
.login-hero h1 { font-size: 32px; line-height: 1.28; margin: 12px 0 0; font-weight: 600; letter-spacing: -0.03em; }
.login-hero p { color: rgba(255, 255, 255, 0.68); font-size: 15px; line-height: 1.7; margin: 0; }
.login-points { list-style: none; padding: 0; margin: 8px 0 0; display: grid; gap: 10px; }
.login-points li { position: relative; padding-left: 22px; color: rgba(255, 255, 255, 0.82); font-size: 14px; }
.login-points li::before { content: "✓"; position: absolute; left: 0; color: #8b93e8; font-weight: 700; }
.login-form-wrap { display: grid; place-items: center; padding: 40px; }
.login-card { width: min(400px, 100%); background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 32px; }
.login-card h2 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.03em; }
.input-icon { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 8px; padding: 0 10px; height: 42px; color: var(--muted); }
.input-icon:focus-within { border-color: #b8beea; box-shadow: 0 0 0 3px rgba(94, 106, 210, 0.14); }
.input-icon input { border: 0; outline: 0; height: 100%; flex: 1; background: transparent; color: var(--text); }
.login-tip { margin: 16px 0 0; font-size: 12px; color: var(--muted); text-align: center; }
@media (max-width: 860px) { .login-page { grid-template-columns: 1fr; } .login-hero { display: none; } }
</style>

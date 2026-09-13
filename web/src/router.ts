import { createRouter, createWebHistory } from "vue-router";

import { firstAllowedPath, hasPerm } from "./auth";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", component: () => import("./views/Login.vue"), meta: { public: true } },
    { path: "/", redirect: "/records" },
    { path: "/records", component: () => import("./views/Records.vue"), meta: { perm: "records.view" } },
    { path: "/workbench/:id?", component: () => import("./views/Workbench.vue"), meta: { perm: "workbench.use" } },
    { path: "/customers", component: () => import("./views/Customers.vue"), meta: { perm: "customers.view" } },
    { path: "/projects", component: () => import("./views/Projects.vue"), meta: { perm: "projects.view" } },
    { path: "/knowledge", component: () => import("./views/Knowledge.vue"), meta: { perm: "knowledge.view" } },
    { path: "/settings", component: () => import("./views/Settings.vue"), meta: { perm: "settings.manage" } },
    { path: "/users", component: () => import("./views/Users.vue"), meta: { perm: "users.manage" } },
    { path: "/roles", component: () => import("./views/Roles.vue"), meta: { perm: "roles.manage" } },
  ],
});

router.beforeEach((to) => {
  const authed = !!localStorage.getItem("token");
  if (!to.meta.public && !authed) {
    return { path: "/login", query: to.fullPath !== "/" ? { redirect: to.fullPath } : undefined };
  }
  if (to.path === "/login" && authed) return { path: firstAllowedPath() };
  const perm = to.meta.perm as string | undefined;
  if (perm && !hasPerm(perm)) return { path: firstAllowedPath() };
  return true;
});

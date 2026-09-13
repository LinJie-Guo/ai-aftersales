import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { redactSensitiveText } from "../agent/redact.ts";

import { translateSshError } from "../agent/tools/ssh.ts";

import { requireAnyPerm, requirePerm } from "./access.ts";
import { login, logout, requireUser } from "./auth.ts";
import * as crud from "./crud.ts";
import * as roles from "./roles.ts";
import * as sessions from "./sessions.ts";
import { serveWeb } from "./static.ts";
import * as users from "./users.ts";

function toChineseError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/All configured authentication methods failed|Permission denied|ECONNREFUSED|ETIMEDOUT|Cannot parse privateKey/i.test(raw)) {
    return translateSshError(error);
  }
  return raw;
}

export function createApp() {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    const message = redactSensitiveText(toChineseError(error));
    console.error(message);
    return c.json({ detail: message }, 500);
  });
  app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] }));
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/api/v1/files/:name", requireUser, crud.getUploadedFile);

  const api = new Hono();
  api.post("/auth/login", login);
  api.post("/auth/logout", logout);
  api.use("/*", requireUser);
  api.get("/auth/me", users.me);

  api.get("/users", requirePerm("users.manage"), users.listUsers);
  api.post("/users", requirePerm("users.manage"), users.createUser);
  api.put("/users/:id", requirePerm("users.manage"), users.updateUser);

  api.get("/roles/catalog", requirePerm("roles.manage"), roles.listRoleCatalog);
  api.get("/roles", requireAnyPerm("roles.manage", "users.manage"), roles.listRoles);
  api.post("/roles", requirePerm("roles.manage"), roles.createRole);
  api.put("/roles/:id", requirePerm("roles.manage"), roles.updateRole);
  api.delete("/roles/:id", requirePerm("roles.manage"), roles.deleteRole);

  api.get("/projects", requireAnyPerm("projects.view", "customers.write"), crud.listProjects);
  api.post("/projects", requirePerm("projects.write"), crud.createProject);
  api.put("/projects/:id", requirePerm("projects.write"), crud.updateProject);
  api.post("/projects/parse-repos", requirePerm("projects.write"), crud.parseRepos);
  api.post("/projects/test-git", requirePerm("projects.write"), crud.testProjectGit);

  api.get("/customers", requireAnyPerm("customers.view", "users.manage", "records.write"), crud.listCustomers);
  api.get("/customers/:id", requirePerm("customers.view"), crud.getCustomer);
  api.post("/customers", requirePerm("customers.write"), crud.createCustomer);
  api.put("/customers/:id", requirePerm("customers.write"), crud.updateCustomer);
  api.post("/customers/:id/pull", requirePerm("customers.pull"), crud.pullCode);
  api.post("/customers/:id/test-ssh", requirePerm("customers.ssh"), crud.testSsh);
  api.post("/customers/:id/uploads", requirePerm("customers.write"), crud.uploadRecord);

  api.get("/records", requirePerm("records.view"), crud.listRecords);
  api.get("/records/:id", requirePerm("records.view"), crud.getRecord);
  api.post("/records", requirePerm("records.write"), crud.createRecord);
  api.post("/records/:id/close", requirePerm("records.write"), crud.closeRecord);
  api.post("/records/:id/customer-reply", requirePerm("records.write"), crud.customerReply);
  api.get("/records/:id/context", requirePerm("records.view"), crud.recordContext);
  api.post("/records/:id/uploads", requireAnyPerm("records.write", "workbench.use"), crud.uploadRecord);
  api.get("/records/:id/sessions/latest", requirePerm("workbench.use"), sessions.latestSession);

  api.get("/knowledge", requirePerm("knowledge.view"), crud.listKnowledge);
  api.get("/knowledge/:id", requirePerm("knowledge.view"), crud.getKnowledge);
  api.put("/knowledge/:id", requirePerm("knowledge.write"), crud.updateKnowledge);
  api.post("/knowledge/:id/publish", requirePerm("knowledge.write"), crud.publishKnowledge);
  api.post("/knowledge/from-record/:id", requirePerm("knowledge.write"), crud.knowledgeFromRecord);
  api.delete("/knowledge/:id", requirePerm("knowledge.delete"), crud.deleteKnowledge);

  api.get("/settings/model", requireAnyPerm("settings.manage", "workbench.use"), crud.getModelConfig);
  api.put("/settings/model", requirePerm("settings.manage"), crud.saveModelConfig);
  api.post("/settings/model/test", requirePerm("settings.manage"), crud.testModelConfig);
  api.post("/settings/model/models", requirePerm("settings.manage"), crud.listProviderModels);
  api.get("/settings/git-credential", requirePerm("settings.manage"), crud.getGitCredential);
  api.put("/settings/git-credential", requirePerm("settings.manage"), crud.saveGitCredential);

  api.post("/sessions", requirePerm("workbench.use"), sessions.createSession);
  api.get("/models", requirePerm("workbench.use"), sessions.modelCatalog);
  api.post("/sessions/:id/followup", requirePerm("workbench.use"), sessions.followupSession);
  api.post("/sessions/:id/steer", requirePerm("workbench.use"), sessions.steerSession);
  api.get("/sessions/:id/inbox", requirePerm("workbench.use"), sessions.listInbox);
  api.post("/sessions/:id/inbox", requirePerm("workbench.use"), sessions.inboxSession);
  api.post("/sessions/:id/inbox/:itemId", requirePerm("workbench.use"), sessions.updateInbox);
  api.post("/sessions/:id/cancel", requirePerm("workbench.use"), sessions.cancelSession);
  api.post("/sessions/:id/answer", requirePerm("customers.ssh"), sessions.answerSession);
  api.get("/sessions/:id/approvals", requirePerm("workbench.use"), sessions.sessionApprovals);
  api.get("/sessions/:id/artifacts/:artifactId", requirePerm("workbench.use"), sessions.sessionArtifact);
  api.get("/sessions/:id/events", requirePerm("workbench.use"), sessions.listSessionEvents);
  api.get("/sessions/:id/stream", requirePerm("workbench.use"), sessions.replaySession);

  app.route("/api/v1", api);
  app.use("*", serveWeb);
  return app;
}

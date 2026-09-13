<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  Plus, X, BookPlus, CheckCheck, FileText, Sparkles, MessageSquare,
  Square, RotateCcw, Building2, ArrowUp, ShieldCheck, Code2, ChevronDown,
} from "lucide-vue-next";
import { api, streamAttach, streamFollowup, streamResume, type AgentEvent, type ChatAttachment, type ContextInfo, type InboxRow, type Message, type SessionEvent } from "../api";
import { eventTime, groupProcess, projectEvents, type TranscriptItem } from "../transcript";
import ContextRing from "../components/ContextRing.vue";
import ModelPicker from "../components/ModelPicker.vue";
import QueueDock from "../components/QueueDock.vue";
import ThinkingProcess from "../components/ThinkingProcess.vue";
import AgentNotice from "../components/AgentNotice.vue";
import CommandApproval from "../components/CommandApproval.vue";
import EvidencePanel from "../components/EvidencePanel.vue";
import KnowledgeToggle from "../components/KnowledgeToggle.vue";
import { messageNotice } from "../messageNotice";
import ToolCallRow from "../components/ToolCallRow.vue";
import { renderMarkdown } from "../markdown";
import { toolTitle } from "../toolDisplay";
import { formatDateTime } from "../format";
import { notify } from "../toast";
import { confirmAction } from "../confirm";
import {
  clearStreamActive,
  isStreamActive,
  listenStreamEvents,
  notifyStreamEnd,
  notifyStreamStart,
} from "../streamLock";

const AI_NAME = "排查助手";
const username = localStorage.getItem("username") || "admin";

const route = useRoute();
const router = useRouter();
const record = ref<any>(null);
const customer = ref<any>(null);
const messages = ref<Message[]>([]);
const allEvents = ref<SessionEvent[]>([]);
const transcript = ref<TranscriptItem[]>([]);
const input = ref("");
const permission = ref<"code" | "env">("env");
const referenceKnowledge = ref(false);
const modelName = ref("");
const sending = ref(false);
const streamBlocked = ref(false);
const waitingRemote = ref(false);
const streamText = ref("");
const thinkingText = ref("");
const processNote = ref("正在连接模型…");
const streamRef = ref<HTMLElement | null>(null);
const dragging = ref(false);
const ctxInfo = ref<ContextInfo | null>(null);
interface ToolTimelineStep {
  kind: "tool";
  id: string;
  label: string;
  status: "running" | "done" | "error";
  summary?: string;
  args?: Record<string, unknown>;
  elapsed_ms?: number;
  artifact_ref?: string | null;
}
interface ProcessNoteStep {
  kind: "note";
  id: string;
  content: string;
}
type LiveProcessItem = ToolTimelineStep | ProcessNoteStep;
const liveProcessItems = ref<LiveProcessItem[]>([]);
const liveToolCount = computed(() => liveProcessItems.value.filter((item) => item.kind === "tool").length);
let liveNoteSeq = 0;
const runMode = ref<"fast" | "normal" | "deep">("fast");
const confirmedFacts = ref<{ id: string; claim: string }[]>([]);
const blockers = ref<{ id: string; description: string; required_input?: string }[]>([]);
const latestCheckpoint = ref<string | null>(null);
const currentRunId = ref<string | null>(null);
const resumeAvailable = ref(false);
const restoredRunStatus = ref<string | null>(null);
const validationMessage = ref("");
const sawToolsThisStep = ref(false);
const draftAnswer = ref("");
const thinkingCollapsed = ref(true);
const evidenceOpen = ref(false);
const evidenceSelected = ref("");
const approvals = ref<any[]>([]);
const historyLimit = ref(60);
const renderTranscript = computed(() => visibleTranscript.value.slice(-historyLimit.value));
function openEvidence(id = "") { evidenceSelected.value = id; evidenceOpen.value = true; }
function evidenceLink(event: MouseEvent) {
  const anchor = (event.target as HTMLElement)?.closest("a");
  const href = anchor?.getAttribute("href") || "";
  if (href.startsWith("#evidence-")) { event.preventDefault(); openEvidence(href.slice(10)); }
}
async function refreshApprovals() {
  if (!currentRunId.value) { approvals.value = []; return; }
  try { approvals.value = (await api.approvals(currentRunId.value)).items || []; } catch { /* existing requests remain visible */ }
}
async function showEarlier() {
  const el = streamRef.value, height = el?.scrollHeight || 0;
  historyLimit.value += 40; await nextTick();
  if (el) el.scrollTop += el.scrollHeight - height;
}
function continueWithEvidence() { void send("继续本次排查，沿用已保存的现场证据；先说明阻塞点，不要重复已失败的相同操作。"); }
const thinkingStartedAt = ref<number | null>(null);
const thinkingElapsedMs = ref(0);
let thinkingTimer: ReturnType<typeof setInterval> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollCount = 0;
const POLL_MS = 3000;
const POLL_MAX = 200;

function isReplyPending() {
  const last = messages.value[messages.value.length - 1];
  return !!(last && last.role === "user");
}

function isLockError(msg: string) {
  return msg.includes("排查") || msg.includes("稍候");
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  waitingRemote.value = false;
  pollCount = 0;
}

function applyEvents(events: SessionEvent[]) {
  allEvents.value = events;
  transcript.value = projectEvents(events);
  messages.value = transcript.value
    .filter((item) => item.kind === "user" || item.kind === "assistant")
    .map((item) => ({
      id: item.key,
      role: item.kind === "user" ? "user" : "ai",
      content: item.content,
      created_at: new Date().toISOString(),
    } as Message));
}

function rememberEvent(event: SessionEvent) {
  if (event.data?.transient) return;
  if (typeof event.seq !== "number") return;
  const exists = allEvents.value.some((item) => item.seq === event.seq && item.type === event.type);
  if (exists) return;
  allEvents.value.push(event);
  if (
    event.type === "user/message"
    || event.type === "assistant/message"
    || event.type === "tool/call"
    || event.type === "tool/result"
    || event.type === "assistant/reasoning-complete"
    || event.type === "assistant/attempt"
  ) {
    applyEvents(allEvents.value);
  }
}

const runInProgress = computed(() => sending.value || restoredRunStatus.value === "running");

const visibleTranscript = computed(() => {
  const items = transcript.value;
  if (!runInProgress.value) return groupProcess(items);
  let lastAssistant = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === "assistant") lastAssistant = i;
  }
  let opener = -1;
  for (let i = lastAssistant + 1; i < items.length; i++) {
    if (items[i].kind === "user") {
      opener = i;
      break;
    }
  }
  if (opener < 0) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === "user") {
        opener = i;
        break;
      }
    }
  }
  if (opener < 0) return groupProcess(items);
  const head = items.slice(0, opener + 1);
  const followups = items.slice(opener + 1).filter((item) => item.kind === "user");
  return groupProcess([...head, ...followups]);
});

const BUSY_ENTER_KEY = "aftersale:busyEnter";
const busyEnter = ref<"queue" | "steer">(localStorage.getItem(BUSY_ENTER_KEY) === "steer" ? "steer" : "queue");
const queueItems = ref<InboxRow[]>([]);
const enqueueing = ref(false);

function setBusyEnter(behavior: "queue" | "steer") {
  busyEnter.value = behavior;
  localStorage.setItem(BUSY_ENTER_KEY, behavior);
}

function resolveSubmitMode(running: boolean, gesture: "enter" | "accelerated"): "queue" | "steer" {
  if (!running) return "queue";
  if (gesture === "enter") return busyEnter.value;
  return busyEnter.value === "queue" ? "steer" : "queue";
}

function adoptInbox(items?: InboxRow[]) {
  queueItems.value = (items ?? []).filter((item) => item.placement === "queued");
}

async function refreshInbox() {
  if (!currentRunId.value) {
    queueItems.value = [];
    return;
  }
  try {
    const res = await api.sessionInboxList(currentRunId.value);
    adoptInbox(res.items);
  } catch { /* keep local snapshot */ }
}

async function refreshRecord(rid: string) {
  const fresh = await api.record(rid);
  record.value.rounds = fresh.rounds;
  record.value.status = fresh.status;
  record.value.conclusion = fresh.conclusion;
  record.value.handler_name = fresh.handler_name || fresh.handlerName;
  record.value.handler_id = fresh.handler_id || fresh.handlerId;
  await restoreLatestRun(rid);
  await scrollBottom();
  return fresh;
}

function startPollForReply(rid: string) {
  if (pollTimer || !isReplyPending()) return;
  waitingRemote.value = true;
  pollCount = 0;
  pollTimer = setInterval(async () => {
    pollCount += 1;
    try {
      const fresh = await refreshRecord(rid);
      if (fresh.messages[fresh.messages.length - 1]?.role === "ai") {
        stopPoll();
        return;
      }
      if (pollCount >= POLL_MAX) stopPoll();
    } catch {
      if (pollCount >= 5) stopPoll();
    }
  }, POLL_MS);
}

function currentTurnStartedAt(events: SessionEvent[]) {
  let start: number | null = null;
  for (const event of events) {
    if (event.type === "turn/start") start = eventTime(event) ?? start;
    else if (event.type === "turn/end") start = null;
  }
  return start;
}

function startThinkingTimer(fromMs?: number) {
  const start = fromMs ?? currentTurnStartedAt(allEvents.value) ?? thinkingStartedAt.value ?? Date.now();
  thinkingStartedAt.value = start;
  thinkingElapsedMs.value = Math.max(0, Date.now() - start);
  if (thinkingTimer) clearInterval(thinkingTimer);
  thinkingTimer = setInterval(() => {
    if (thinkingStartedAt.value) thinkingElapsedMs.value = Date.now() - thinkingStartedAt.value;
  }, 500);
}
function stopThinkingTimer() {
  if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
  if (thinkingStartedAt.value) thinkingElapsedMs.value = Date.now() - thinkingStartedAt.value;
}
function formatElapsed(ms: number) {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
function formatMsgTime(value?: string | null) {
  return formatDateTime(value);
}
function formatStreamStart(ms: number | null) {
  if (!ms) return "";
  return formatDateTime(new Date(ms).toISOString());
}
const summaryExpanded = ref(false);
const customerOpen = ref(false);
const displayRounds = computed(() => {
  const ended = allEvents.value.filter((event) => event.type === "turn/end" && event.data?.reason !== "aborted").length;
  if (ended) return ended;
  const started = allEvents.value.filter((event) => event.type === "turn/start").length;
  if (started) return started;
  const users = allEvents.value.filter((event) => (
    event.type === "user/message"
    && (!event.data?.source || event.data.source === "human")
  )).length;
  return users || Number(record.value?.rounds || 0);
});
const customerRepos = computed(() => (customer.value?.repos || []).map((repo: any) => ({
  id: repo.id || repo.repo_url || repo.repoUrl,
  name: repo.repo_name || repo.repoName || "未命名仓库",
  url: repo.repo_url || repo.repoUrl || "",
  extra: [repo.branch, repo.tag].filter(Boolean).join(" · "),
})));

async function openCustomer() {
  customerOpen.value = true;
  const rid = record.value?.id as string | undefined;
  if (rid) {
    try {
      await refreshRecord(rid);
    } catch { /* keep current snapshot */ }
  }
}
/** 工具步骤默认折叠；仅用户点开的 id 为 true */
const expandedToolSteps = ref<Record<string, boolean>>({});

function toggleToolStep(id: string) {
  expandedToolSteps.value = {
    ...expandedToolSteps.value,
    [id]: !expandedToolSteps.value[id],
  };
}

function upsertStep(step: Omit<ToolTimelineStep, "kind">) {
  const i = liveProcessItems.value.findIndex((item) => item.kind === "tool" && item.id === step.id);
  if (i >= 0) liveProcessItems.value[i] = { ...liveProcessItems.value[i], ...step, kind: "tool" };
  else liveProcessItems.value.push({ ...step, kind: "tool" });
}

function appendLiveNote(text: string) {
  if (!text) return;
  const items = liveProcessItems.value;
  const last = items[items.length - 1];
  if (last?.kind === "note") {
    items[items.length - 1] = { ...last, content: last.content + text };
    liveProcessItems.value = items.slice();
    return;
  }
  liveNoteSeq += 1;
  liveProcessItems.value = [...items, { kind: "note", id: `note-${liveNoteSeq}`, content: text }];
}

function dropTrailingNote(content: string) {
  const items = liveProcessItems.value;
  const last = items[items.length - 1];
  if (last?.kind === "note" && last.content === content) {
    liveProcessItems.value = items.slice(0, -1);
  }
}

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const attachments = ref<ChatAttachment[]>([]);
const uploading = ref(false);

const priorityMeta: Record<string, { label: string; cls: string }> = {
  p0: { label: "P0 紧急", cls: "red" },
  p1: { label: "P1 高", cls: "amber" },
  p2: { label: "P2 普通", cls: "blue" },
};
const statusMeta: Record<string, { label: string; cls: string }> = {
  processing: { label: "排查中", cls: "amber" },
  located: { label: "排查中", cls: "amber" },
  await_customer: { label: "排查中", cls: "amber" },
  closed: { label: "已关闭", cls: "gray" },
};

const fileRef = ref<HTMLInputElement | null>(null);
const ticketClosed = computed(() => record.value?.status === "closed");
const canSend = computed(() =>
  !ticketClosed.value && !enqueueing.value && !uploading.value && (!!input.value.trim() || attachments.value.length > 0),
);

const canSteerQueue = computed(() =>
  runInProgress.value && !!currentRunId.value && queueItems.value.length > 0 && !input.value.trim() && !attachments.value.length,
);

const composerPlaceholder = computed(() => {
  if (canSteerQueue.value) return "Cmd/Ctrl+Enter 插话发送全部排队消息";
  if (runInProgress.value) {
    return busyEnter.value === "queue"
      ? "Enter 排队发送，Cmd/Ctrl+Enter 插话发送"
      : "Enter 插话发送，Cmd/Ctrl+Enter 排队发送";
  }
  return "给排查助手发消息，可拖拽或 Ctrl/Cmd + V 粘贴截图、日志、文档";
});

async function onModelChanged() {
  if (record.value?.id) await loadContext(record.value.id);
}

function onPickFiles(e: Event) {
  const el = e.target as HTMLInputElement;
  if (el.files?.length) uploadFiles(el.files);
  el.value = "";
}

async function loadContext(id: string) {
  try {
    ctxInfo.value = await api.recordContext(id);
  } catch { /* ignore */ }
}

let unloadStreamListener: (() => void) | null = null;

function shouldAutoStream(id: string) {
  if (
    ticketClosed.value
    || sending.value
    || streamBlocked.value
    || resumeAvailable.value
    || restoredRunStatus.value === "running"
    || isStreamActive(id)
  ) return false;
  const last = messages.value[messages.value.length - 1];
  return !!(last && last.role === "user");
}

function lastEventSeq(events: SessionEvent[]) {
  return events.reduce((max, event) => (typeof event.seq === "number" && event.seq > max ? event.seq : max), 0);
}

function hydrateLiveFromEvents(events: SessionEvent[]) {
  let start = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === "turn/start") start = i;
  }
  const terminal: TerminalEvent = { type: "", data: {} };
  for (const event of events.slice(start)) handleAgentEvent(event, terminal);
}

let liveWatch: AbortController | null = null;

function stopLiveWatch() {
  liveWatch?.abort();
  liveWatch = null;
}

async function watchLiveSession(sessionId: string, afterSeq = 0) {
  stopLiveWatch();
  const ac = new AbortController();
  liveWatch = ac;
  restoredRunStatus.value = "running";
  if (!thinkingText.value && !liveProcessItems.value.length) {
    processNote.value = "";
  }
  startThinkingTimer();
  const terminal: TerminalEvent = { type: "", data: {} };
  try {
    await streamAttach(sessionId, afterSeq, (event) => handleAgentEvent(event, terminal), ac.signal);
    if (ac.signal.aborted) return;
    if (terminal.type !== "run.completed" && terminal.type !== "run.failed" && restoredRunStatus.value === "running") {
      processNote.value = "实时连接已断开，正在恢复本轮…";
      await streamAttach(sessionId, lastEventSeq(allEvents.value), (event) => handleAgentEvent(event, terminal), ac.signal);
      if (ac.signal.aborted) return;
    }
    if (terminal.type === "run.failed") notify.error(String(terminal.data.message || "排查失败"));
    if (terminal.type !== "run.completed" && restoredRunStatus.value === "running") {
      processNote.value = "本轮输出中断，请再发一次或刷新页面";
    }
    restoredRunStatus.value = terminal.type === "run.completed" ? "idle" : restoredRunStatus.value;
    if (restoredRunStatus.value !== "running") stopThinkingTimer();
    const rid = record.value?.id;
    if (rid) await refreshRecord(rid);
  } catch (error: any) {
    if (ac.signal.aborted || error?.name === "AbortError") return;
    const rid = record.value?.id;
    if (rid && isReplyPending()) startPollForReply(rid);
  }
}

async function load(id: string) {
  stopPoll();
  stopLiveWatch();
  summaryExpanded.value = false;
  customerOpen.value = false;
  record.value = await api.record(id);
  messages.value = record.value.messages;
  try {
    customer.value = await api.customer(record.value.customer_id);
  } catch { /* ignore */ }
  await restoreLatestRun(id);
  const lastUser = [...allEvents.value].reverse().find((event) => event.type === "user/message" && (event.data.source === "human" || event.data.source === "steer"));
  referenceKnowledge.value = lastUser?.data.referenceKnowledge === true;
  modelName.value = String([...allEvents.value].reverse().find((event) => event.type === "turn/settings")?.data.modelName || lastUser?.data.modelName || "");
  await loadContext(id);
  await scrollBottom();
  const draft = sessionStorage.getItem(`aftersale:draft:${id}`);
  if (draft) {
    sessionStorage.removeItem(`aftersale:draft:${id}`);
    if (!ticketClosed.value) {
      const parsed = parseDraft(draft);
      referenceKnowledge.value = parsed.referenceKnowledge;
      attachments.value = parsed.attachments;
      await send(parsed.text || record.value.description || record.value.title);
      return;
    }
  }
  if (restoredRunStatus.value === "running" && currentRunId.value) {
    hydrateLiveFromEvents(allEvents.value);
    void watchLiveSession(currentRunId.value, lastEventSeq(allEvents.value));
    return;
  }
  if (shouldAutoStream(id)) {
    send("", true);
  } else if (
    isReplyPending()
    && (isStreamActive(id) || streamBlocked.value || restoredRunStatus.value === "running")
  ) {
    startPollForReply(id);
  }
}

async function restoreLatestRun(recordId: string) {
  currentRunId.value = null;
  approvals.value = [];
  historyLimit.value = 60;
  queueItems.value = [];
  latestCheckpoint.value = null;
  resumeAvailable.value = false;
  restoredRunStatus.value = null;
  liveProcessItems.value = [];
  thinkingText.value = "";
  draftAnswer.value = "";
  streamText.value = "";
  confirmedFacts.value = [];
  blockers.value = [];
  validationMessage.value = "";
  try {
    const response = await api.latestAgentRun(recordId);
    if (!response?.id) return;
    currentRunId.value = String(response.id);
    permission.value = response.permission === "env" ? "env" : "code";
    restoredRunStatus.value = String(response.status || "");
    resumeAvailable.value = response.status === "idle" || response.status === "cancelled";
    const events = (response.events || []) as SessionEvent[];
    applyEvents(events);
    latestCheckpoint.value = String([...events].reverse().find((e) => e.type === "context/checkpoint")?.data.artifactId || "") || null;
    if (restoredRunStatus.value === "running") {
      hydrateLiveFromEvents(events);
      startThinkingTimer();
    } else stopThinkingTimer();
    await refreshInbox();
    await refreshApprovals();
  } catch { /* keep existing transcript */ }
  if (!transcript.value.length && record.value?.messages?.length) {
    transcript.value = record.value.messages
      .filter((item: Message) => item.content?.trim())
      .map((item: Message) => ({
        key: item.id,
        kind: item.role === "user" ? "user" : "assistant",
        content: item.content,
        author: record.value?.handler_name || record.value?.handlerName,
      }));
  }
}

const pinToBottom = ref(true);

function isNearBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 64;
}

function onStreamScroll() {
  const el = streamRef.value;
  if (!el) return;
  pinToBottom.value = isNearBottom(el);
}

async function scrollBottom(force = false) {
  await nextTick();
  const el = streamRef.value;
  if (!el) return;
  if (!force && !pinToBottom.value) return;
  el.scrollTop = el.scrollHeight;
}

function renderMessage(content: string) {
  return renderMarkdown(content);
}

function takeAttachments() {
  const pending = [...attachments.value];
  attachments.value = [];
  return pending;
}

function parseDraft(raw: string): { text: string; attachments: ChatAttachment[]; referenceKnowledge: boolean } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed) as { text?: string; attachments?: ChatAttachment[]; referenceKnowledge?: boolean };
      if (json && typeof json === "object" && (json.text != null || json.attachments)) {
        return {
          text: String(json.text || ""),
          referenceKnowledge: json.referenceKnowledge === true,
          attachments: Array.isArray(json.attachments) ? json.attachments.filter((item) => item?.view_url || item?.stored_name) : [],
        };
      }
    } catch {
      /* legacy markdown draft */
    }
  }
  return { text: raw, attachments: [], referenceKnowledge: false };
}

async function uploadFiles(files: FileList | File[]) {
  if (!record.value?.id) return notify.warning("请先加载排查记录");
  uploading.value = true;
  try {
    for (const file of Array.from(files)) {
      if (file.size > MAX_UPLOAD_BYTES) {
        notify.error(`${file.name} 超过 12MB`);
        continue;
      }
      try {
        const res = await api.uploadToRecord(record.value.id, file);
        attachments.value.push({
          file_name: res.file_name || file.name,
          stored_name: res.stored_name || res.storedName || "",
          view_url: res.view_url,
          mime_type: res.mime_type || file.type,
          is_image: Boolean(res.is_image ?? (res.mime_type || file.type || "").startsWith("image/")),
        });
      } catch (error: any) {
        notify.error(error?.response?.data?.detail || `上传失败：${file.name}`);
      }
    }
  } finally {
    uploading.value = false;
  }
}
function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.items || [])
    .filter((it) => it.kind === "file")
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f);
  if (files.length) { e.preventDefault(); uploadFiles(files); }
}
function onDrop(e: DragEvent) {
  dragging.value = false;
  if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
}
function removeAttachment(i: number) { attachments.value.splice(i, 1); }

interface TerminalEvent {
  type: string;
  data: Record<string, any>;
}

function handleAgentEvent(event: AgentEvent, terminal: TerminalEvent) {
  const data = event.data || {};
  if (event.type === "session/ready") {
    currentRunId.value = String(data.sessionId || data.session_id || "");
  } else if (event.type === "turn/start") {
    restoredRunStatus.value = "running";
    processNote.value = "开始本轮排查，等待模型输出过程";
    thinkingText.value = "";
    draftAnswer.value = "";
    streamText.value = "";
    liveProcessItems.value = [];
    expandedToolSteps.value = {};
    sawToolsThisStep.value = false;
    startThinkingTimer(eventTime(event) ?? Date.now());
  } else if (event.type === "user/message") {
    const id = String(data.id || "");
    const content = String(data.content || "");
    queueItems.value = queueItems.value.filter((item) => item.id !== id && item.content !== content);
  } else if (event.type === "step/start") {
    sawToolsThisStep.value = false;
    draftAnswer.value = "";
    if (!thinkingText.value) processNote.value = "";
  } else if (event.type === "llm/request") {
    if (!thinkingText.value) processNote.value = "";
  } else if (event.type === "llm/usage") {
    if (record.value?.id) void loadContext(record.value.id);
  } else if (event.type === "tool/call") {
    sawToolsThisStep.value = true;
    processNote.value = `正在调用${toolTitle(String(data.name))}`;
    const callId = String(data.callId || data.call_id);
    upsertStep({
      id: callId,
      label: String(data.name),
      status: "running",
      args: data.arguments && typeof data.arguments === "object" ? data.arguments : undefined,
    });
    expandedToolSteps.value = { ...expandedToolSteps.value, [callId]: false };
  } else if (event.type === "tool/result") {
    upsertStep({
      id: String(data.callId || data.call_id),
      label: String(data.name),
      status: data.status === "success" ? "done" : "error",
      summary: String(data.summary || ""),
      artifact_ref: data.artifactId || data.artifact_id || null,
    });
  } else if (event.type === "approval/request") {
    if (!approvals.value.some((item) => item.id === data.id)) approvals.value.push(data);
    processNote.value = "等待你确认具体远程操作";
  } else if (event.type === "approval/resolved") {
    approvals.value = approvals.value.filter((item) => item.id !== data.id);
  } else if (event.type === "context/checkpoint") {
    latestCheckpoint.value = String(data.artifactId || "");
    processNote.value = "已保存上下文检查点，继续排查";
  } else if (event.type === "investigation/state") {
    confirmedFacts.value = (data.facts || []).map((item: any, i: number) => ({ id: String(i + 1), claim: `${item.inferred ? '推断：' : item.evidenceStatuses?.some((status: string) => status !== 'success') ? '失败证据：' : '证据记录：'}${item.claim}` }));
    blockers.value = (data.blockers || []).map((item: string, i: number) => ({ id: String(i), description: item }));
  } else if (event.type === "assistant/live-snapshot") {
    thinkingText.value = String(data.reasoning || "");
    draftAnswer.value = String(data.text || "");
    if (draftAnswer.value) appendLiveNote(draftAnswer.value);
  } else if (event.type === "assistant/reasoning-complete") {
    thinkingText.value = String(data.text || "");
  } else if (event.type === "assistant/reasoning") {
    thinkingText.value += String(data.text || "");
    processNote.value = "";
  } else if (event.type === "assistant/chunk") {
    const text = String(data.text || "");
    draftAnswer.value += text;
    appendLiveNote(text);
  } else if (event.type === "assistant/message") {
    const toolCalls = data.toolCalls;
    const content = String(data.content || draftAnswer.value);
    if (Array.isArray(toolCalls) && toolCalls.length) {
      streamText.value = "";
    } else {
      dropTrailingNote(draftAnswer.value);
      streamText.value = content;
    }
  } else if (event.type === "session/status" && data.status === "idle") {
    terminal.type = "run.completed";
    terminal.data = data;
    restoredRunStatus.value = "idle";
    void refreshInbox();
  } else if (event.type === "turn/end") {
    if (data.reason === "aborted") {
      terminal.type = "run.failed";
      terminal.data = data;
    }
  }
  if (event.type !== "session/ready") rememberEvent(event);
  void scrollBottom();
}

async function enqueueDuringRun(mode: "queue" | "steer", text?: string): Promise<boolean> {
  if (ticketClosed.value) return false;
  const raw = (text ?? input.value).trim();
  if (!raw && !attachments.value.length) return false;
  const sessionId = currentRunId.value;
  if (!sessionId) return false;
  const pending = takeAttachments();
  enqueueing.value = true;
  try {
    const res = await api.sessionInbox(sessionId, { content: raw, mode, permission: permission.value, attachments: pending, referenceKnowledge: referenceKnowledge.value, modelName: modelName.value });
    if (!res?.accepted) {
      attachments.value = [...pending, ...attachments.value];
      return false;
    }
    adoptInbox(res.items);
    if (res.notice) notify.info(res.notice);
    input.value = "";
    return true;
  } catch (error: any) {
    attachments.value = [...pending, ...attachments.value];
    if (error?.response?.status === 409) return false;
    notify.error("发送失败，请稍后重试");
    return true;
  } finally {
    enqueueing.value = false;
  }
}

async function updateQueued(itemId: string, action: { kind: "edit"; content: string } | { kind: "remove" } | { kind: "steer" }) {
  const sessionId = currentRunId.value;
  if (!sessionId) return;
  try {
    const res = await api.updateSessionInbox(sessionId, itemId, action);
    adoptInbox(res.items);
  } catch (error: any) {
    const code = error?.response?.data?.code;
    if (code === "steer-unavailable" || code === "queue-item-not-found") {
      notify.info(code === "steer-unavailable" ? "模型或知识设置与当前轮不同，请保留排队，在下一轮执行。" : "该消息已执行或移除，队列已刷新。");
      await refreshInbox();
      return;
    }
    notify.error(action.kind === "edit" ? "保存排队消息失败" : action.kind === "remove" ? "删除排队消息失败" : "插话发送失败，请重试");
  }
}

async function steerAllQueued() {
  const rows = [...queueItems.value];
  for (const row of rows) {
    await updateQueued(row.id, { kind: "steer" });
  }
}

function onComposerKeydown(e: KeyboardEvent) {
  if (e.key !== "Enter") return;
  if (e.shiftKey) return;
  const composing = e.isComposing || e.keyCode === 229;
  if (composing) return;
  e.preventDefault();
  if (e.repeat || enqueueing.value) return;
  const accelerated = e.ctrlKey || e.metaKey;
  if (accelerated && canSteerQueue.value) {
    void steerAllQueued();
    return;
  }
  if (!canSend.value) return;
  const mode = resolveSubmitMode(runInProgress.value && !!currentRunId.value, accelerated ? "accelerated" : "enter");
  if (runInProgress.value && currentRunId.value) void enqueueDuringRun(mode);
  else void send();
}

async function send(text?: string, auto = false) {
  const sentKnowledgeChoice = referenceKnowledge.value;
  const sentModelName = modelName.value;
  if (ticketClosed.value) return;
  const raw = auto ? "" : (text ?? input.value).trim();
  if (!auto && !raw && !attachments.value.length) return;
  const rid = record.value?.id as string | undefined;
  if (!rid) return;
  if (
    !auto
    && resumeAvailable.value
    && currentRunId.value
    && latestCheckpoint.value
  ) {
    if (text !== undefined) input.value = text;
    await resumeCurrentRun();
    return;
  }
  const liveNow = sending.value || restoredRunStatus.value === "running" || isStreamActive(rid);
  if (!auto && currentRunId.value && liveNow) {
    const mode = resolveSubmitMode(true, "enter");
    const accepted = await enqueueDuringRun(mode, raw);
    if (accepted) return;
    if (sending.value) {
      notify.warning("本轮刚结束，请再发一次");
      return;
    }
  }
  if (sending.value || streamBlocked.value || isStreamActive(rid)) {
    if (auto || isReplyPending()) {
      startPollForReply(rid);
      return;
    }
    notify.warning("该工单正在排查中，请稍候");
    return;
  }
  const pending = auto ? [] : takeAttachments();
  const content = auto ? "" : raw;
  if (!auto) {
    messages.value.push({ id: crypto.randomUUID(), role: "user", content, created_at: new Date().toISOString() } as Message);
    const last = transcript.value[transcript.value.length - 1];
    if (!(last?.kind === "user" && last.content === content && last.attachments?.length === pending.length)) {
      transcript.value = [...transcript.value, { key: `u-local-${Date.now()}`, kind: "user", content, at: new Date().toISOString(), author: username, attachments: pending }];
    }
    input.value = "";
  }
  sending.value = true;
  notifyStreamStart(rid);
  streamText.value = "";
  thinkingText.value = "";
  draftAnswer.value = "";
  sawToolsThisStep.value = false;
  processNote.value = "正在连接模型…";
  liveProcessItems.value = [];
  expandedToolSteps.value = {};
  runMode.value = "fast";
  confirmedFacts.value = [];
  blockers.value = [];
  latestCheckpoint.value = null;
  const sessionId = currentRunId.value;
  resumeAvailable.value = false;
  restoredRunStatus.value = "running";
  validationMessage.value = "";
  thinkingCollapsed.value = true;
  startThinkingTimer();
  pinToBottom.value = true;
  await scrollBottom(true);
  try {
    const terminal: { type: string; data: Record<string, any> } = { type: "", data: {} };
    const attached = await streamFollowup(
      rid,
      content,
      permission.value,
      (event) => handleAgentEvent(event, terminal),
      sessionId,
      { attachments: pending, referenceKnowledge: sentKnowledgeChoice, modelName: sentModelName },
    );
    if (attached?.accepted) {
      const sid = String(attached.sessionId || sessionId || currentRunId.value || "");
      if (sid) await watchLiveSession(sid, lastEventSeq(allEvents.value));
    }
    stopThinkingTimer();
    notifyStreamEnd(rid);
    if (terminal.type === "run.failed") {
      const message = String(terminal.data.message || "排查失败");
      sending.value = false;
      await refreshRecord(rid);
      if (isLockError(message)) {
        startPollForReply(rid);
        return;
      }
      notify.error(message);
      return;
    }
    stopPoll();
    streamText.value = "";
    sending.value = false;
    await refreshRecord(rid);
  } catch {
    stopThinkingTimer();
    notifyStreamEnd(rid);
    sending.value = false;
    resumeAvailable.value = Boolean(currentRunId.value && latestCheckpoint.value);
    notify.error("排查请求失败，请稍后重试");
  }
  await loadContext(rid);
}

async function cancelCurrentRun() {
  const rid = record.value?.id as string | undefined;
  if (!rid || !currentRunId.value) return;
  try {
    await api.cancelAgentRun(rid, currentRunId.value);
    notify.info("已请求停止，Agent 会在当前模型或工具调用结束后安全退出");
  } catch {
    notify.error("停止请求失败");
  }
}

async function resumeCurrentRun() {
  const sentKnowledgeChoice = referenceKnowledge.value;
  const sentModelName = modelName.value;
  const rid = record.value?.id as string | undefined;
  const runId = currentRunId.value;
  if (!rid || !runId || !latestCheckpoint.value || sending.value) return;
  sending.value = true;
  resumeAvailable.value = false;
  notifyStreamStart(rid);
  streamText.value = "";
  validationMessage.value = "";
  thinkingCollapsed.value = true;
  startThinkingTimer();
  pinToBottom.value = true;
  await scrollBottom(true);
  const terminal: TerminalEvent = { type: "", data: {} };
  const pending = takeAttachments();
  const continuation = input.value.trim();
  if (continuation || pending.length) {
    messages.value.push({
      id: crypto.randomUUID(),
      role: "user",
      content: continuation,
      created_at: new Date().toISOString(),
    } as Message);
    input.value = "";
  }
  try {
    const attached = await streamResume(
      rid,
      runId,
      continuation,
      (event) => handleAgentEvent(event, terminal),
      permission.value,
      { attachments: pending, referenceKnowledge: sentKnowledgeChoice, modelName: sentModelName },
    );
    if (attached?.accepted) {
      await watchLiveSession(runId, lastEventSeq(allEvents.value));
    }
    if (terminal.type === "run.failed") {
      notify.error(String(terminal.data.message || "续跑失败"));
    }
    streamText.value = "";
    await refreshRecord(rid);
  } catch {
    resumeAvailable.value = true;
    notify.error("续跑请求失败，请稍后重试");
  } finally {
    stopThinkingTimer();
    notifyStreamEnd(rid);
    sending.value = false;
    await loadContext(rid);
  }
}


async function closeTicket() {
  const ok = await confirmAction({
    title: "关闭工单",
    message: `确认关闭 ${record.value.code}「${record.value.title}」？关闭后不能再继续排查。`,
    okText: "确认关闭",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.closeRecord(record.value.id);
    record.value.status = "closed";
    notify.success("工单已关闭");
  } catch {
    notify.error("关闭失败，请稍后重试");
  }
}
async function sink() {
  const ok = await confirmAction({
    title: "沉淀知识",
    message: `确认把 ${record.value.code} 的排查结论沉淀到知识库？生成后可在「知识沉淀」里查看和修改。`,
    okText: "确认沉淀",
  });
  if (!ok) return;
  try {
    await api.knowledgeFromRecord(record.value.id);
    notify.success("已生成知识文档，后续类似问题会优先检索");
  } catch {
    notify.error("沉淀失败，请稍后重试");
  }
}

onMounted(() => {
  const id = route.params.id as string;
  if (id) {
    unloadStreamListener = listenStreamEvents(
      id,
      () => {
        streamBlocked.value = true;
        if (isReplyPending()) startPollForReply(id);
      },
      () => {
        streamBlocked.value = false;
        refreshRecord(id).then((fresh) => {
          if (fresh.messages[fresh.messages.length - 1]?.role === "ai") stopPoll();
          else if (shouldAutoStream(id)) send("", true);
        });
      },
    );
    load(id);
  }
});
onUnmounted(() => {
  stopPoll();
  stopLiveWatch();
  unloadStreamListener?.();
  if (record.value?.id) clearStreamActive(record.value.id);
});
watch(() => route.params.id, (id, prev) => {
  if (!id || id === prev) return;
  stopPoll();
  stopLiveWatch();
  unloadStreamListener?.();
  streamBlocked.value = false;
  unloadStreamListener = listenStreamEvents(
    id as string,
    () => {
      streamBlocked.value = true;
      if (isReplyPending()) startPollForReply(id as string);
    },
    () => {
      streamBlocked.value = false;
      refreshRecord(id as string).then((fresh) => {
        if (fresh.messages[fresh.messages.length - 1]?.role === "ai") stopPoll();
        else if (shouldAutoStream(id as string)) send("", true);
      });
    },
  );
  load(id as string);
});
</script>

<template>
  <div v-if="!record" class="wb-empty">
    <div class="wb-empty-card">
      <div class="wb-empty-icon"><Sparkles :size="30" /></div>
      <h1>AI 排查工作区</h1>
      <p>请先从「售后记录」选择一条工单进入排查。进入后可与 AI 多轮对话、拖拽 / 粘贴日志截图，并一键沉淀知识。</p>
      <div class="wb-empty-actions">
        <button class="btn primary" @click="router.push('/records')"><MessageSquare :size="16" />去售后记录</button>
        <button class="btn" @click="router.push('/records')"><Plus :size="16" />新建排查</button>
      </div>
    </div>
  </div>

  <template v-else>
    <EvidencePanel v-if="currentRunId" :open="evidenceOpen" :session-id="currentRunId" :events="allEvents" :selected-id="evidenceSelected" @close="evidenceOpen = false" />
    <div class="wb-topbar">
      <div class="wb-topbar-main">
        <span class="badge gray mono">{{ record.code }}</span>
        <h1 class="wb-title">{{ record.title }}</h1>
        <span class="badge" :class="priorityMeta[record.priority]?.cls">{{ priorityMeta[record.priority]?.label }}</span>
        <span class="badge" :class="statusMeta[record.status]?.cls">{{ statusMeta[record.status]?.label || record.status }}</span>
        <button type="button" class="wb-customer-chip" @click="openCustomer">
          <Building2 :size="14" />
          <span>{{ record.customer_name || "客户信息" }}</span>
        </button>
      </div>
      <div class="wb-topbar-actions">
        <button class="btn green" @click="sink"><BookPlus :size="16" />沉淀知识</button>
        <button class="btn" :disabled="record.status === 'closed'" @click="closeTicket"><CheckCheck :size="16" />关闭工单</button>
        <button class="btn" @click="router.push('/records')"><Plus :size="16" />新建排查</button>
      </div>
    </div>

    <div v-if="customerOpen" class="modal-mask" @click.self="customerOpen = false">
      <div class="modal sm customer-modal">
        <div class="modal-head">
          <div>
            <h2>本次客户信息</h2>
            <p class="panel-sub">AI 基于该客户代码、环境入口和手动资产排查</p>
          </div>
          <button class="btn" @click="customerOpen = false"><X :size="16" />关闭</button>
        </div>
        <div class="modal-body">
          <div class="info-group">
            <div class="info-group-title">基础信息</div>
            <div class="context-line"><span>客户</span><strong>{{ record.customer_name }}</strong></div>
            <div class="context-line"><span>项目</span><strong>{{ customer?.project_name || "-" }}</strong></div>
            <div class="context-line"><span>客户分支</span><strong class="mono">{{ customer?.branch || "-" }}</strong></div>
            <div class="context-line"><span>客户 Tag</span><strong class="mono">{{ customer?.tag || "-" }}</strong></div>
            <div class="context-line">
              <span>代码仓库</span>
              <div class="repo-hover">
                <span class="badge blue">{{ customerRepos.length }} 个</span>
                <div v-if="customerRepos.length" class="repo-pop">
                  <div v-for="repo in customerRepos" :key="repo.id" class="repo-pop-item">
                    <strong>{{ repo.name }}</strong>
                    <span v-if="repo.url" class="mono">{{ repo.url }}</span>
                    <span v-if="repo.extra" class="muted">{{ repo.extra }}</span>
                  </div>
                </div>
              </div>
            </div>
            <div class="context-line"><span>问题描述</span><strong>{{ record.description || "-" }}</strong></div>
            <div class="context-line"><span>轮次</span><strong>{{ displayRounds }}</strong></div>
            <div class="context-line"><span>处理人</span><strong>{{ record.handler_name || record.handlerName || "-" }}</strong></div>
          </div>
          <div class="info-group">
            <div class="info-group-title">环境连接</div>
            <div class="context-line"><span>环境 IP</span><strong class="mono">{{ customer?.env_ip || "-" }}</strong></div>
            <div class="context-line"><span>工作目录</span><strong class="mono">{{ customer?.workdir || "-" }}</strong></div>
          </div>
          <div class="info-group">
            <div class="info-group-title">手动补充资产</div>
            <div class="context-line">
              <span>资产</span>
              <span class="asset-tags">
                <span v-for="a in customer?.assets || []" :key="a.id" class="badge green">{{ a.name || a.asset_type }}</span>
                <span v-if="!customer?.assets?.length" class="muted">未配置</span>
              </span>
            </div>
          </div>
          <div v-if="record.conclusion" class="info-group">
            <div class="info-group-title">当前结论</div>
            <div class="summary-conclusion md-body" :class="{ expanded: summaryExpanded }" v-html="renderMessage(record.conclusion)"></div>
            <button
              v-if="record.conclusion.length > 120"
              class="summary-toggle"
              @click="summaryExpanded = !summaryExpanded"
            >
              {{ summaryExpanded ? "收起" : "展开全文" }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="workbench-layout">
      <!-- 对话 -->
      <section class="panel chat-panel">
        <div ref="streamRef" class="chat-stream" @scroll.passive="onStreamScroll" @click="evidenceLink">
          <button v-if="visibleTranscript.length > historyLimit" class="btn small" @click="showEarlier">加载更早的对话</button>
          <div v-for="item in renderTranscript" :key="item.key" class="message" :class="item.kind === 'user' ? 'user' : item.kind === 'process' ? 'process' : item.kind === 'tool' ? 'tool' : 'ai'">
            <div v-if="item.kind === 'user'">
              <div class="message-meta">
                <span>{{ item.author || record.handler_name || record.handlerName || "用户" }}</span>
                <span v-if="item.source === 'steer'" class="steer-tag">修正</span>
                <span v-if="item.referenceKnowledge != null" class="message-time">{{ item.referenceKnowledge ? '参考历史知识' : '不参考历史知识' }}</span>
                <span v-if="item.at" class="message-time">{{ formatMsgTime(item.at) }}</span>
              </div>
              <div v-if="item.content.trim()" class="bubble md-body" v-html="renderMessage(item.content)"></div>
              <div v-if="item.attachments?.length" class="attachment-strip in-message">
                <a
                  v-for="(a, i) in item.attachments"
                  :key="`${item.key}-a-${i}`"
                  class="attachment-chip"
                  :href="a.view_url"
                  target="_blank"
                  rel="noreferrer"
                >
                  <img v-if="a.is_image" :src="a.view_url" :alt="a.file_name" />
                  <FileText v-else :size="14" />
                  <span>{{ a.file_name }}</span>
                </a>
              </div>
            </div>
            <ThinkingProcess
              v-else-if="item.kind === 'process'"
              :elapsed-ms="item.elapsedMs"
              :tool-count="item.items.filter((step) => step.kind === 'tool').length"
            >
              <template v-for="step in item.items" :key="step.key">
                <p v-if="step.kind === 'thinking' || step.kind === 'note'" class="think-prose">{{ step.content }}</p>
                <ToolCallRow
                  v-else
                  :name="step.name"
                  :status="step.status"
                  :summary="step.summary"
                  :args="step.args"
                  :expanded="!!expandedToolSteps[step.callId]"
                  :evidence-id="step.callId"
                  @evidence="openEvidence"
                  @toggle="toggleToolStep(step.callId)"
                />
              </template>
            </ThinkingProcess>
            <ThinkingProcess v-else-if="item.kind === 'thinking'">
              <p class="think-prose">{{ item.content }}</p>
            </ThinkingProcess>
            <ToolCallRow
              v-else-if="item.kind === 'tool'"
              :name="item.name"
              :status="item.status"
              :summary="item.summary"
              :args="item.args"
              :expanded="!!expandedToolSteps[item.callId]"
              :evidence-id="item.callId"
              @evidence="openEvidence"
              @toggle="toggleToolStep(item.callId)"
            />
            <div v-else>
              <div class="message-meta">
                <span>{{ AI_NAME }}</span>
                <span v-if="item.kind === 'assistant' && item.at" class="message-time">{{ formatMsgTime(item.at) }}</span>
                <span v-if="item.kind === 'assistant' && item.elapsedMs" class="thinking-time">本轮 {{ formatElapsed(item.elapsedMs) }}</span>
                <span v-if="item.kind === 'assistant' && ['blocked', 'needs_input', 'incomplete', 'budget'].includes(item.outcome || '')" class="thinking-time">{{ ({ blocked: '排查受阻', needs_input: '需要补充信息', incomplete: '尚未确认完成', budget: '待继续' } as Record<string, string>)[item.outcome!] }}</span>
              </div>
              <AgentNotice v-if="messageNotice(item.content)" :content="item.content" :actionable="item.key === visibleTranscript[visibleTranscript.length - 1]?.key && !ticketClosed" :busy="runInProgress" @retry="continueWithEvidence" @evidence="openEvidence()" />
              <div v-else class="bubble md-body" v-html="renderMessage(item.content)"></div>
            </div>
          </div>
          <div v-if="waitingRemote && !sending && !transcript.length" class="message ai">
            <div class="message-meta"><span>{{ AI_NAME }}</span></div>
            <div class="bubble waiting-bubble">
              <span class="muted">排查进行中，正在等待结果…</span><span class="blink">▍</span>
            </div>
          </div>
          <div v-if="runInProgress" class="message ai">
            <div class="message-meta">
              <span>{{ AI_NAME }}</span>
              <span v-if="thinkingStartedAt" class="message-time">{{ formatStreamStart(thinkingStartedAt) }}</span>
            </div>
            <ThinkingProcess
              :key="currentRunId || 'live'"
              :open="!thinkingCollapsed"
              :elapsed-ms="thinkingElapsedMs"
              :tool-count="liveToolCount"
              :current-step="processNote || '正在整理分析结果…'"
              live
            >
              <div v-if="latestCheckpoint || validationMessage" class="run-status-line">
                <span v-if="latestCheckpoint" class="muted mono">checkpoint {{ latestCheckpoint.slice(0, 8) }}</span>
                <span v-if="validationMessage" class="validation-note">{{ validationMessage }}</span>
              </div>
              <p v-if="thinkingText" class="think-prose">{{ thinkingText }}</p>
              <div v-if="confirmedFacts.length" class="fact-list">
                <div v-for="fact in confirmedFacts" :key="fact.id" class="fact-row">
                  <span class="fact-id">{{ fact.id }}</span><span>{{ fact.claim }}</span>
                </div>
              </div>
              <div v-if="blockers.length" class="blocker-list">
                <div v-for="blocker in blockers" :key="blocker.id" class="blocker-row">
                  {{ blocker.description }}<span v-if="blocker.required_input">：{{ blocker.required_input }}</span>
                </div>
              </div>
              <div v-if="liveProcessItems.length" class="tool-list">
                <template v-for="s in liveProcessItems" :key="s.id">
                  <p v-if="s.kind === 'note'" class="think-prose">{{ s.content }}</p>
                  <ToolCallRow
                    v-else
                    :name="s.label"
                    :status="s.status"
                    :summary="s.summary"
                    :args="s.args"
                    :expanded="!!expandedToolSteps[s.id]"
                    :elapsed-ms="s.elapsed_ms"
                    :evidence-id="s.id"
                    @evidence="openEvidence"
                    @toggle="toggleToolStep(s.id)"
                  />
                </template>
              </div>
            </ThinkingProcess>
            <AgentNotice v-if="streamText && messageNotice(streamText)" :content="streamText" />
            <div v-else-if="streamText" class="bubble md-body">
              <span v-html="renderMessage(streamText)"></span><span class="blink">▍</span>
            </div>
          </div>
          <template v-if="currentRunId"><CommandApproval v-for="request in approvals" :key="request.id" :session-id="currentRunId" :request="request" @resolved="refreshApprovals" /></template>
        </div>

        <div
          v-if="ticketClosed"
          class="chat-composer closed-composer"
        >
          <div class="closed-banner">工单已关闭，仅可查看排查记录。</div>
        </div>
        <div
          v-else
          class="chat-composer"
          :class="{ dragging }"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="onDrop"
        >
          <div v-if="resumeAvailable && currentRunId && latestCheckpoint" class="resume-banner">
            <span>本次排查已保存检查点，可从现有事实和证据继续，无需重新开始。</span>
            <button class="btn" :disabled="sending" @click="resumeCurrentRun">
              <RotateCcw :size="15" />从检查点继续
            </button>
          </div>
          <div v-if="attachments.length" class="attachment-strip">
            <span v-for="(a, i) in attachments" :key="i" class="attachment-chip">
              <img v-if="a.is_image" :src="a.view_url" :alt="a.file_name" />
              <FileText v-else :size="14" />
              <span>{{ a.file_name }}</span>
              <button @click="removeAttachment(i)"><X :size="13" /></button>
            </span>
          </div>
          <div class="composer-stack" :class="{ queued: queueItems.length }">
            <QueueDock
              :rows="queueItems"
              :running="runInProgress"
              :update="updateQueued"
            />
            <div class="composer-box">
              <textarea
                v-model="input"
                :placeholder="composerPlaceholder"
                @paste="onPaste"
                @keydown="onComposerKeydown"
              ></textarea>
              <div class="composer-bar">
                <div class="composer-bar-left">
                  <button type="button" class="icon-btn" title="上传截图、日志或文档" @click="fileRef?.click()">
                    <Plus :size="18" />
                  </button>
                  <input
                    ref="fileRef"
                    type="file"
                    multiple
                    hidden
                    accept="image/*,.txt,.md,.log,.json,.csv,.tsv,.xml,.yml,.yaml,.html,.pdf,.docx,.xlsx,.pptx"
                    @change="onPickFiles"
                  />
                  <label
                    class="perm-pill"
                    title="只读代码不连接客户机；允许环境可连接客户服务器，受限只读查询可自动执行，其他命令需逐次审批。下次发送生效。"
                  >
                    <ShieldCheck v-if="permission === 'env'" :size="14" />
                    <Code2 v-else :size="14" />
                    <select v-model="permission" :disabled="sending">
                      <option value="env">允许环境</option>
                      <option value="code">只读代码</option>
                    </select>
                    <ChevronDown :size="12" />
                  </label>
                  <KnowledgeToggle v-model="referenceKnowledge" />
                  <label
                    class="perm-pill enter-pill"
                    title="仅在助手运行时生效；Cmd/Ctrl+Enter 使用另一种发送"
                  >
                    <select :value="busyEnter" @change="setBusyEnter(($event.target as HTMLSelectElement).value as 'queue' | 'steer')">
                      <option value="queue">排队发送</option>
                      <option value="steer">插话发送</option>
                    </select>
                    <ChevronDown :size="12" />
                  </label>
                </div>
                <div class="composer-bar-right">
                  <ModelPicker v-model="modelName" :disabled="uploading" @changed="onModelChanged" />
                  <ContextRing :info="ctxInfo" />
                  <button
                    v-if="runInProgress && currentRunId"
                    type="button"
                    class="send-fab stop"
                    title="停止"
                    @click="cancelCurrentRun"
                  >
                    <Square :size="14" />
                  </button>
                  <button
                    type="button"
                    class="send-fab"
                    :title="runInProgress
                      ? (busyEnter === 'queue' ? '排队发送' : '插话发送')
                      : '发送'"
                    :disabled="!canSend"
                    @click="send()"
                  >
                    <ArrowUp :size="18" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </template>
</template>

<style scoped>
.wb-topbar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 14px 18px; background: var(--surface); color: var(--text);
  border: 1px solid var(--line); border-radius: 12px;
  box-shadow: var(--shadow);
}
.wb-topbar-main { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; min-width: 0; flex: 1; }
.wb-topbar-main > .mono { max-width: 210px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-topbar-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; flex-shrink: 0; }
@media(max-width:1100px) { .wb-topbar { flex-direction: column; align-items: stretch; gap: 12px; } .wb-topbar-main { flex: auto; } .wb-topbar-actions { flex-shrink: 1; } .wb-topbar-main .wb-title { max-width: 100%; } }
.wb-title { margin: 0; font-size: 17px; font-weight: 800; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 28vw; color: var(--text); }
.wb-customer-chip {
  display: inline-flex; align-items: center; gap: 6px;
  min-height: 30px; padding: 0 10px; border: 1px solid var(--line); border-radius: 999px;
  background: var(--surface); color: var(--text); font-size: 12.5px; cursor: pointer;
}
.wb-customer-chip:hover { border-color: #b8beea; background: #f8f8ff; color: var(--blue); }
.chat-composer.dragging { outline: 2px dashed var(--blue); outline-offset: -4px; background: #eff6ff; }
.closed-banner {
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}

.composer-stack { display: flex; flex-direction: column; }
.composer-stack.queued .composer-box {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
  position: relative;
  z-index: 1;
}
.composer-box {
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--surface);
  color: var(--text);
  padding: 10px 12px 8px;
  display: grid;
  gap: 6px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.composer-box:focus-within {
  border-color: #c7cbe8;
  box-shadow: 0 0 0 3px rgba(94, 106, 210, 0.12);
}
.composer-box textarea {
  width: 100%;
  min-height: 52px;
  max-height: 180px;
  resize: none;
  border: 0;
  outline: 0;
  padding: 2px 4px;
  background: transparent;
  line-height: 1.55;
  color: var(--text);
}
.composer-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.composer-bar-left,
.composer-bar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.composer-bar-left { flex-wrap: wrap; }
.composer-bar-right { margin-left: auto; }
.icon-btn {
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #64748b;
  display: grid;
  place-items: center;
  padding: 0;
}
.icon-btn:hover { background: #f1f5f9; color: #334155; }
.perm-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 8px 0 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 12.5px;
  position: relative;
  cursor: pointer;
}
.perm-pill:hover { border-color: var(--line-strong); background: var(--surface); }
.perm-pill select {
  appearance: none;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  padding: 0;
  margin: 0;
  cursor: pointer;
  outline: 0;
  max-width: 88px;
}
.perm-pill select:disabled { cursor: not-allowed; }
.perm-pill svg:last-child { color: #94a3b8; flex: none; }
.enter-pill select { max-width: 88px; }
.send-fab {
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 999px;
  background: var(--blue);
  color: #fff;
  display: grid;
  place-items: center;
  padding: 0;
  flex: none;
}
.send-fab:hover { background: var(--blue-hover); }
.send-fab:disabled { background: #d4d4d8; color: #fff; cursor: not-allowed; }
.send-fab.stop { background: #475569; }
.send-fab.stop:hover { background: #334155; }
.steer-tag {
  font-size: 11px;
  font-weight: 600;
  color: #5b4fc9;
  background: #f5f3ff;
  border-radius: 999px;
  padding: 0 6px;
}
.resume-banner {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-bottom: 8px; padding: 8px 10px; border: 1px solid #bfdbfe; border-radius: 9px;
  background: #eff6ff; color: #1e40af; font-size: 12px;
}

.wb-empty { display: grid; place-items: center; min-height: calc(100vh - 140px); }
.wb-empty-card {
  max-width: 520px; text-align: center; padding: 40px 32px; background: var(--surface); color: var(--text);
  border: 1px solid var(--line); border-radius: var(--radius);
}
.wb-empty-icon {
  width: 56px; height: 56px; margin: 0 auto 18px; border-radius: 14px; display: grid; place-items: center;
  color: var(--blue); background: var(--blue-soft);
}
.wb-empty-card h1 { margin: 0 0 10px; font-size: 22px; }
.wb-empty-card p { margin: 0 0 22px; color: var(--muted); font-size: 14px; line-height: 1.7; }
.wb-empty-actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }

.message-time { font-weight: 400; font-variant-numeric: tabular-nums; }
.thinking-time { margin-left: 4px; font-size: 12px; color: var(--muted); font-weight: 500; }
.run-status-line { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 11px; }
.process-note { color: var(--muted); }
.validation-note { color: #0f766e; }
.fact-list, .blocker-list { display: grid; gap: 4px; }
.fact-row, .blocker-row { display: flex; gap: 7px; padding: 6px 8px; border-radius: 7px; font-size: 12px; line-height: 1.45; }
.fact-row { background: #ecfdf5; color: #065f46; }
.fact-id { flex: none; font-weight: 800; }
.blocker-row { background: #fff7ed; color: #9a3412; }

.tool-list { display: grid; gap: 2px; }

.spin { animation: wb-spin 0.9s linear infinite; }
@keyframes wb-spin { to { transform: rotate(360deg); } }

.waiting-bubble { background: #f8fafc; border: 1px dashed #cbd5e1; }
.summary-conclusion :deep(.md-table) { font-size: 12px; }
.summary-conclusion :deep(.md-table th),
.summary-conclusion :deep(.md-table td) { padding: 4px 6px; }
.customer-modal .modal-body { overflow: visible; }
.repo-hover { position: relative; display: inline-flex; justify-content: flex-end; }
.repo-hover .badge { cursor: default; }
.repo-pop {
  display: none;
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 8;
  min-width: 260px;
  max-width: 360px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow);
}
.repo-hover:hover .repo-pop,
.repo-hover:focus-within .repo-pop { display: grid; gap: 8px; }
.repo-pop-item { display: grid; gap: 2px; padding: 6px 8px; border-radius: 8px; background: var(--surface-2); }
.repo-pop-item strong { font-size: 12.5px; color: var(--text); text-align: left; }
.repo-pop-item .mono { font-size: 11.5px; color: #64748b; text-align: left; word-break: break-all; }
.repo-pop-item .muted { font-size: 11px; text-align: left; }
</style>

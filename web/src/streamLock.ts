const CHANNEL = "aftersale-stream";
const TTL_MS = 15 * 60 * 1000;

function key(recordId: string) {
  return `aftersale:stream:${recordId}`;
}

export function isStreamActive(recordId: string): boolean {
  const raw = sessionStorage.getItem(key(recordId));
  if (!raw) return false;
  const ts = Number(raw);
  if (!Number.isFinite(ts) || Date.now() - ts > TTL_MS) {
    sessionStorage.removeItem(key(recordId));
    return false;
  }
  return true;
}

export function markStreamActive(recordId: string) {
  sessionStorage.setItem(key(recordId), String(Date.now()));
}

export function clearStreamActive(recordId: string) {
  sessionStorage.removeItem(key(recordId));
}

let channel: BroadcastChannel | null = null;

export function getStreamChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL);
  return channel;
}

export function notifyStreamStart(recordId: string) {
  markStreamActive(recordId);
  getStreamChannel()?.postMessage({ type: "start", recordId });
}

export function notifyStreamEnd(recordId: string) {
  clearStreamActive(recordId);
  getStreamChannel()?.postMessage({ type: "end", recordId });
}

export function listenStreamEvents(
  recordId: string,
  onOtherTabStart: () => void,
  onOtherTabEnd: () => void,
) {
  const bc = getStreamChannel();
  if (!bc) return () => {};
  const handler = (event: MessageEvent) => {
    const data = event.data as { type?: string; recordId?: string };
    if (data?.recordId !== recordId) return;
    if (data.type === "start") onOtherTabStart();
    if (data.type === "end") onOtherTabEnd();
  };
  bc.addEventListener("message", handler);
  return () => bc.removeEventListener("message", handler);
}

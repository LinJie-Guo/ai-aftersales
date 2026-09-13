import type { SessionEvent } from "./api";

/** Only text deltas coalesce; structural events flush first to keep ordering. */
export function batchStream(deliver: (event: SessionEvent) => void) {
  let pending: SessionEvent[] = [];
  let frame = 0;
  const flush = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    const ready = pending; pending = [];
    for (const event of ready) deliver(event);
  };
  const push = (event: SessionEvent) => {
    if (event.type !== "assistant/chunk" && event.type !== "assistant/reasoning") { flush(); deliver(event); return; }
    const last = pending[pending.length - 1];
    if (last?.type === event.type && last.data.turn === event.data.turn && last.data.step === event.data.step) last.data.text = String(last.data.text || "") + String(event.data.text || "");
    else pending.push({ ...event, data: { ...event.data } });
    if (!frame) frame = requestAnimationFrame(flush);
  };
  return { push, flush };
}

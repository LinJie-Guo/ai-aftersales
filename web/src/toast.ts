type ToastType = "success" | "warning" | "error" | "info";

const icons: Record<ToastType, string> = {
  success: "M20 6 9 17l-5-5",
  warning: "M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
  error: "M18 6 6 18M6 6l12 12",
  info: "M12 16v-4m0-4h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
};

function ensureWrap(): HTMLElement {
  let wrap = document.querySelector<HTMLElement>(".toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "toast-wrap";
    document.body.appendChild(wrap);
  }
  return wrap;
}

export function toast(message: string, type: ToastType = "success", duration = 2400) {
  const wrap = ensureWrap();
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${icons[type]}"/></svg><span></span>`;
  el.querySelector("span")!.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .18s ease, transform .18s ease";
    el.style.opacity = "0";
    el.style.transform = "translateY(-12px)";
    setTimeout(() => el.remove(), 200);
  }, duration);
}

export const notify = {
  success: (m: string, duration?: number) => toast(m, "success", duration ?? 2400),
  warning: (m: string, duration?: number) => toast(m, "warning", duration ?? 2400),
  error: (m: string, duration?: number) => toast(m, "error", duration ?? 3600),
  info: (m: string, duration?: number) => toast(m, "info", duration ?? 2400),
};

export function confirmAction(input: {
  title: string;
  message: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "modal-mask confirm-mask";
    mask.innerHTML = `
      <div class="modal sm confirm-dialog" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h2></h2>
        </div>
        <div class="modal-body"><p class="confirm-text"></p></div>
        <div class="modal-foot">
          <button type="button" class="btn confirm-cancel"></button>
          <button type="button" class="btn confirm-ok"></button>
        </div>
      </div>
    `;
    const title = mask.querySelector("h2")!;
    const text = mask.querySelector(".confirm-text")!;
    const cancel = mask.querySelector<HTMLButtonElement>(".confirm-cancel")!;
    const ok = mask.querySelector<HTMLButtonElement>(".confirm-ok")!;
    title.textContent = input.title;
    text.textContent = input.message;
    cancel.textContent = input.cancelText || "取消";
    ok.textContent = input.okText || "确认";
    if (input.danger) ok.classList.add("danger");
    else ok.classList.add("primary");

    const finish = (value: boolean) => {
      mask.remove();
      window.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish(false);
    };
    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    mask.addEventListener("click", (event) => {
      if (event.target === mask) finish(false);
    });
    window.addEventListener("keydown", onKey);
    document.body.appendChild(mask);
    ok.focus();
  });
}

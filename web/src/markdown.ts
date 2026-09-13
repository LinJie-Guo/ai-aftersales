/** 轻量 Markdown 渲染（聊天气泡用，防 XSS） */

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Same-origin file requests use an HttpOnly cookie, never a token in the URL. */
export function authFileUrl(url: string): string {
  if (/^(?:https?:\/\/|\/[^/]|#)/i.test(url.trim())) return url.trim().replace(/([?&])access_token=[^&#]*&?/g, "$1").replace(/[?&]$/, "");
  return "#";
}

export function renderMarkdown(content: string): string {
  if (!content) return "";

  const codeBlocks: string[] = [];
  let text = content.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre class="md-code"><code>${escapeHtml(code.trim())}</code></pre>`);
    return `\u0000CODE${idx}\u0000`;
  });

  // 图片 / 链接占位（escape 前处理 URL）
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<img class="md-img" src="${escapeHtml(authFileUrl(url))}" alt="${escapeHtml(alt)}" />`);
    return `\u0000CODE${idx}\u0000`;
  });
  text = text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_m, t, url) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<a href="${escapeHtml(authFileUrl(url))}" target="_blank" rel="noopener">${escapeHtml(t)}</a>`);
    return `\u0000CODE${idx}\u0000`;
  });

  text = escapeHtml(text);

  // SSH / 工具状态行
  text = text.replace(/^&gt; ([🔗📂🔍⚠️✓✗].+)$/gm, '<div class="md-status">$1</div>');

  // 标题
  text = text.replace(/^### (.+)$/gm, "<h4 class=\"md-h4\">$1</h4>");
  text = text.replace(/^## (.+)$/gm, "<h3 class=\"md-h3\">$1</h3>");

  // 粗体、行内代码
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/`([^`\n]+)`/g, "<code class=\"md-inline\">$1</code>");

  // 无序列表
  text = text.replace(/^- (.+)$/gm, "<li class=\"md-li\">$1</li>");
  text = text.replace(/((?:<li class="md-li">[\s\S]*?<\/li>\n?)+)/g, '<ul class="md-ul">$1</ul>');

  // 简单表格（| a | b | 格式）
  text = text.replace(
    /(?:^\|(.+)\|\n(?:\|[-:\s|]+\|\n)?(?:\|(.+)\|\n?)+)/gm,
    (block) => {
      const rows = block.trim().split("\n").filter((r) => r.trim() && !/^\|[\s\-:|]+\|$/.test(r.trim()));
      if (rows.length < 1) return block;
      const trs = rows.map((row, i) => {
        const cells = row.split("|").slice(1, -1).map((c) => c.trim());
        const tag = i === 0 ? "th" : "td";
        return `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
      });
      return `<table class="md-table"><tbody>${trs.join("")}</tbody></table>`;
    },
  );

  // 段落：双换行
  text = text.replace(/\n{2,}/g, "</p><p class=\"md-p\">");
  text = `<p class="md-p">${text}</p>`;
  text = text.replace(/\n/g, "<br/>");

  // 还原 code / 图片 / 链接块
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx) => codeBlocks[Number(idx)] || "");

  // 清理空段落
  text = text.replace(/<p class="md-p"><\/p>/g, "");
  text = text.replace(/<p class="md-p">(<h[34])/g, "$1");
  text = text.replace(/(<\/h[34]>)<\/p>/g, "$1");
  text = text.replace(/<p class="md-p">(<div class="md-status")/g, "$1");
  text = text.replace(/(<\/div>)<\/p>/g, "$1");
  text = text.replace(/<p class="md-p">(<pre)/g, "$1");
  text = text.replace(/(<\/pre>)<\/p>/g, "$1");
  text = text.replace(/<p class="md-p">(<ul)/g, "$1");
  text = text.replace(/(<\/ul>)<\/p>/g, "$1");
  text = text.replace(/<p class="md-p">(<table)/g, "$1");
  text = text.replace(/(<\/table>)<\/p>/g, "$1");

  return text;
}

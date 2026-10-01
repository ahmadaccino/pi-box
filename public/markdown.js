/**
 * Small markdown renderer for the transcript: code, tables, and math.
 * Output is HTML with escaped text. Math is left for KaTeX when it is loaded.
 */

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

const TOKEN =
  /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\\n])*`)|(\/\/[^\n]*|#[^\n]*)|(\b\d+(?:\.\d+)?\b)|(\b(?:const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|def|elif|fn|pub|struct|enum|match|select|package|interface|type|new|this|true|false|null|undefined)\b)|([\s\S])/g;

export function highlightCode(code, lang) {
  const source = String(code || "").replace(/\n$/, "");
  TOKEN.lastIndex = 0;
  let html = "";
  let match;
  while ((match = TOKEN.exec(source))) {
    if (match[1]) html += `<span class="hl-str">${escapeHtml(match[1])}</span>`;
    else if (match[2]) html += `<span class="hl-com">${escapeHtml(match[2])}</span>`;
    else if (match[3]) html += `<span class="hl-num">${escapeHtml(match[3])}</span>`;
    else if (match[4]) html += `<span class="hl-kw">${escapeHtml(match[4])}</span>`;
    else html += escapeHtml(match[5]);
  }
  const klass = lang ? ` class="language-${escapeAttr(lang)}"` : "";
  return `<pre><code${klass}>${html}</code></pre>`;
}

function safeHref(url) {
  const value = String(url || "").trim();
  if (/^https?:\/\//i.test(value) || value.startsWith("/") || value.startsWith("#") || /^mailto:/i.test(value)) {
    return value;
  }
  return "#";
}

function inline(text) {
  let src = escapeHtml(text);
  src = src.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => mathSpan(tex, true));
  src = src.replace(/(^|[^\\])\$([^$\n]+?)\$/g, (all, lead, tex) => {
    if (!/[\\a-zA-Z]/.test(tex)) return all;
    return `${lead}${mathSpan(tex, false)}`;
  });
  src = src.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  src = src.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  src = src.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const url = safeHref(href);
    return `<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  return src;
}

function mathSpan(tex, display) {
  const raw = String(tex || "").trim();
  return `<span class="math" data-display="${display ? "block" : "inline"}" data-tex="${escapeAttr(raw)}">${escapeHtml(raw)}</span>`;
}

function isTableSep(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function renderTable(rows) {
  const head = splitRow(rows[0]);
  const body = rows.slice(2).map(splitRow);
  const th = head.map((cell) => `<th>${inline(cell)}</th>`).join("");
  const tr = body
    .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

export function renderMarkdown(source) {
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```([\w-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const lang = fence[1] || "";
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      out.push(highlightCode(buf.join("\n"), lang));
      continue;
    }
    if (line.trim().startsWith("$$") && line.trim().endsWith("$$") && line.trim().length > 4) {
      flushParagraph();
      out.push(mathSpan(line.trim().slice(2, -2), true));
      i += 1;
      continue;
    }
    if (line.trim() === "$$") {
      flushParagraph();
      const buf = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== "$$") {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      out.push(mathSpan(buf.join("\n"), true));
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushParagraph();
      const rows = [line];
      i += 1;
      rows.push(lines[i]);
      i += 1;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(lines[i]);
        i += 1;
      }
      out.push(renderTable(rows));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph();
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      out.push(`<ul>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      i += 1;
      continue;
    }
    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph();
  return out.join("\n");
}

export function mountMath(root, katex) {
  if (!root || !katex?.renderToString) return;
  for (const node of root.querySelectorAll(".math[data-tex]")) {
    try {
      node.innerHTML = katex.renderToString(node.getAttribute("data-tex") || "", {
        displayMode: node.getAttribute("data-display") === "block",
        throwOnError: false,
      });
    } catch {
      /* keep the escaped source */
    }
  }
}

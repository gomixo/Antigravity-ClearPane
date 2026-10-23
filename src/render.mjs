import MarkdownIt from 'markdown-it';
import { tasklist } from '@mdit/plugin-tasklist';
import { katex } from '@mdit/plugin-katex';
import hljs from 'highlight.js/lib/common';
import katexEngine from 'katex';

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
const escape = md.utils.escapeHtml;
md.use(tasklist, { disabled: true, label: false });
md.use(katex, { trust: false, throwOnError: false, maxSize: 20, maxExpand: 1000,
  logger: () => 'ignore', delimiters: 'dollars', transformer: html => html.includes('katex-error') ? `${html}<span class="format-error">公式无法渲染</span>` : html });
const safeLink = href => /^https?:\/\//i.test(href) && !/[\u0000-\u0020]/.test(href);
const safeImage = src => !!src && !/[\u0000-\u001f\u007f]/.test(src) &&
  (safeLink(src) || /^file:\/\/\//i.test(src) || /^[a-z]:(?:[\\/]|%5c|%2f)/i.test(src) ||
    (!/^[a-z][a-z\d+.-]*:/i.test(src) && !/^[\\/]{2}/.test(src)));
md.validateLink = safeImage;
// Image destinations include files; ordinary links keep their existing HTTP-only policy.
for (const name of ['link', 'autolink', 'image']) {
  const rule = md.inline.ruler.__rules__.find(rule => rule.name === name).fn;
  md.inline.ruler.at(name, (state, silent) => {
    const validate = state.md.validateLink;
    state.md.validateLink = name === 'image' ? safeImage : safeLink;
    try { return rule(state, silent); }
    finally { state.md.validateLink = validate; }
  });
}
md.renderer.rules.link_open = (tokens, index) => safeLink(tokens[index].attrGet('href'))
  ? `<span class="document-link"><button type="button" class="copy-link" data-copy-url="${escape(tokens[index].attrGet('href'))}" title="点击复制地址">` : '<span>';
md.renderer.rules.link_close = (tokens, index) => safeLink(tokens.slice(0, index).findLast(token => token.type === 'link_open').attrGet('href')) ? '</button></span>' : '</span>';
md.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const src = token.attrGet('src') ?? '';
  const alt = renderer.renderInlineAsText(token.children ?? [], options, env) || '图片';
  if (!safeImage(src)) return `<span class="image-placeholder">[图片：${escape(alt)}]</span>`;
  const title = token.attrGet('title');
  return `<span class="document-image" data-no-comment><img data-image-src="${escape(src)}" alt="${escape(alt)}"${title ? ` title="${escape(title)}"` : ''} referrerpolicy="no-referrer" decoding="async" hidden><span class="image-placeholder" role="status">${escape(alt)} · 正在加载图片…</span></span>`;
};
function math(tokens, index, displayMode) {
  const source = tokens[index].content;
  const tag = displayMode ? 'div' : 'span';
  let html;
  try { html = katexEngine.renderToString(source, { displayMode, trust: false, throwOnError: true, strict: 'ignore', maxSize: 20, maxExpand: 1000, macros: {} }); }
  catch { html = `<code>${escape(source)}</code><span class="format-error">公式无法渲染，已保留源码。</span>`; }
  return `<${tag} class="generated-math" data-no-comment>${html}</${tag}>`;
}
md.renderer.rules.math_inline = (tokens, index) => math(tokens, index, false);
md.renderer.rules.math_block = (tokens, index) => math(tokens, index, true);
md.renderer.rules.table_open = () => '<div class="table-scroll"><table>';
md.renderer.rules.table_close = () => '</table></div>';
md.renderer.rules.fence = (tokens, index, options, env) => {
  const token = tokens[index];
  const language = token.info.trim().split(/\s+/)[0].toLowerCase();
  if (language === 'mermaid') {
    const number = (env.diagrams ??= []).push(token.content) - 1;
    return `<figure class="diagram" data-no-comment data-diagram="${number}"><pre><code>${escape(token.content)}</code></pre></figure>`;
  }
  let code = escape(token.content);
  if (language && hljs.getLanguage(language)) {
    try { code = hljs.highlight(token.content, { language, ignoreIllegals: true }).value; } catch { /* Plain code remains readable. */ }
  }
  return `<pre><code class="hljs">${code}</code></pre>`;
};
export function renderMarkdown(text) {
  const env = { diagrams: [] };
  // ponytail: detect a delimited field block; displaying raw YAML needs no YAML parser.
  const frontmatter = /^\uFEFF?---[ \t]*\r?\n((?:[^\n]*\n)*?)(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  let properties = '';
  if (frontmatter && /^[^\s#][^:\r\n]*:(?:[ \t]|\r?$)/m.test(frontmatter[1])) {
    properties = `<details class="frontmatter" data-no-comment><summary>文档属性</summary><pre><code>${escape(frontmatter[1])}</code></pre></details>\n`;
    text = text.slice(frontmatter[0].length);
  }
  return { html: properties + md.render(text, env), diagrams: env.diagrams };
}

let mermaidModule;
let renderQueue = Promise.resolve();
let diagramId = 0;
export async function renderDiagrams(container, sources, current, afterLayout, theme = 'neutral') {
  if (!sources.length || !current()) return;
  mermaidModule ??= import('mermaid');
  const { default: mermaid } = await mermaidModule;
  for (const [index, source] of sources.entries()) {
    const node = container.querySelector(`[data-diagram="${index}"]`);
    if (!node || !current()) return;
    const renderOne = async () => {
      if (!current() || !node.isConnected) return;
      try {
        // Content may not supply configuration, CSS, callbacks, icons or remote images.
        if (/%%\s*\{|^\s*click\b|url\s*\(|@\{[^}]*\b(?:image|icon|img|href)\s*:/im.test(source) || source.trimStart().startsWith('---')) throw new Error('Unsupported diagram directive');
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
          htmlLabels: false, maxTextSize: 50000, maxEdges: 500,
          secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels', 'theme', 'themeCSS', 'themeVariables'],
          theme });
        const { svg } = await mermaid.render(`clearpane-diagram-${++diagramId}`, source);
        if (!current() || !node.isConnected) return;
        node.innerHTML = svg;
      } catch {
        if (!current() || !node.isConnected) return;
        node.replaceChildren();
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = source;
        pre.append(code);
        const error = document.createElement('figcaption');
        error.className = 'format-error';
        error.textContent = '图表无法渲染，已保留源码。';
        node.append(pre, error);
      }
      if (current()) afterLayout();
    };
    renderQueue = renderQueue.then(renderOne, renderOne);
    await renderQueue;
  }
}

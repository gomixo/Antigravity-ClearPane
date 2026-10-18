import { PreviewSession, batchMessage, QUOTE_LIMIT, COMMENT_LIMIT, MESSAGE_LIMIT } from './session.mjs';
import { renderMarkdown, renderDiagrams } from './render.mjs';
import { saveRange, restoreRange } from './anchors.mjs';
import { loadImages } from './images.mjs';
import 'katex/dist/katex.min.css';

const $ = id => document.getElementById(id);
const bridge = window.sidecar;
let model = new PreviewSession();
let active = false;
let selection = null;
let controller;
let prefs = { fontSize: 16, lineHeight: 1.8, colorMode: 'system' };
let prefsChanged = 0;
let pendingSettings;
let savingSettings = false;
let anchorRange;
let hoverHeader = false;
let batchFeedback = '';
let feedbackTimer;
let commentOpen = false;
let diagramSources = [];
let diagramGeneration = 0;
let diagramTheme = 'neutral';
let releaseImages;
let boundConversation = conversationId();
const contexts = new Map();
let context;
let disposed = false;
let scrollTimer;
let restoringScroll = false;
let readingTop = 0;
let commentRanges = [];
let autoTimer;
let autoController;
let autoPending = false;
let autoBlocked = true;
let autoResume = false;
let interactionVersion = 0;
let workspaceUris = [];
let workspaceReady = false;
let listSnapshot;
let listScanned = false;
let listOffset = null;
let listGeneration = 0;
let listController;
let listBusy = false;
let searchTimer;
let workspaceUnsubscribe;
const listClient = crypto.randomUUID();
function conversationId() { return bridge?.conversationId ?? null; }
const events = new AbortController();
const on = (target, name, handler) => target.addEventListener(name, handler, { signal: events.signal });
const conversation = () => bridge?.conversationId ?? null;
const note = (text, error = false) => { $('status').textContent = text; $('status').classList.toggle('error', error); };
function setBatchFeedback(text = '', temporary = false) {
  clearTimeout(feedbackTimer);
  if (batchFeedback && $('status').textContent === batchFeedback) note('');
  batchFeedback = text;
  if (temporary) {
    const target = context;
    feedbackTimer = setTimeout(() => {
      if (disposed || context !== target) return;
      batchFeedback = '';
      if ($('status').textContent === text) note('');
      controls();
    }, 4000);
  }
}

async function api(path, body, options = {}) {
  if (!bridge) throw new Error('请在 Antigravity 的 ClearPane 面板打开。');
  const response = await bridge.fetch(path, { method: 'POST', body: JSON.stringify(body), ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败，请重试。');
  return data;
}
function releaseList() {
  const snapshot = listSnapshot;
  clearTimeout(searchTimer);
  listController?.abort();
  listGeneration++;
  listBusy = false;
  listSnapshot = undefined;
  listScanned = false;
  listOffset = null;
  if (bridge && snapshot) void api('/api/files/list', { clientId: listClient, snapshot, release: true }, { keepalive: true }).catch(() => {});
}
async function loadFiles(rescan = false, append = false) {
  if (!active || !workspaceReady || (append && (listBusy || listOffset === null))) return;
  listController?.abort();
  const generation = ++listGeneration;
  const requestController = listController = new AbortController();
  listBusy = true;
  $('files-retry').hidden = true;
  $('files-more').disabled = true;
  if (!append) { $('file-list').replaceChildren(); $('file-list').scrollTop = 0; listOffset = null; }
  if (!workspaceUris.length) {
    releaseList();
    $('files-more').hidden = true;
    $('file-list-status').textContent = '当前会话没有工作区，仍可粘贴文件路径。';
    return;
  }
  $('file-list-status').textContent = '正在加载文章…';
  const scanning = rescan || !listScanned;
  if (scanning) { listSnapshot = crypto.randomUUID(); listScanned = false; }
  try {
    const result = await api('/api/files/list', { clientId: listClient,
      snapshot: listSnapshot, ...(scanning ? { workspaceUris } : {}),
      query: $('file-search').value, offset: append ? listOffset : 0 }, { signal: requestController.signal });
    if (generation !== listGeneration || !active || disposed) return;
    listSnapshot = result.snapshot;
    listScanned = true;
    listOffset = result.nextOffset;
    for (const file of result.files) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'workspace-file';
      button.dataset.path = file.path;
      button.title = `${file.workspace} / ${file.relativePath}`;
      const name = document.createElement('span'); name.textContent = file.name;
      button.append(name);
      $('file-list').append(button);
    }
    $('files-more').hidden = listOffset === null;
    $('file-list-status').textContent = (result.total ? `已显示 ${$('file-list').children.length} / ${result.total} 份` :
      $('file-search').value.trim() ? '没有匹配的文章。' : '工作区没有 Markdown 文章。') +
      (result.warnings ? ' 部分目录无法访问，列表可能不完整。' : '');
    $('files-retry').hidden = !result.warnings;
    controls();
  } catch (error) {
    if (error.name === 'AbortError' || generation !== listGeneration || disposed) return;
    $('file-list-status').textContent = error.message;
    $('files-retry').hidden = false;
    $('files-more').hidden = true;
  } finally {
    if (generation === listGeneration) { listBusy = false; $('files-more').disabled = false; }
  }
}
function updateWorkspaces(uris) {
  if (workspaceReady && JSON.stringify(workspaceUris) === JSON.stringify(uris)) return;
  releaseList();
  workspaceUris = [...uris];
  workspaceReady = true;
  $('file-search').value = '';
  $('file-list').replaceChildren();
  $('files-more').hidden = true;
  if (active && !$('header-content').hidden) void loadFiles(true);
}
function autoAvailable() {
  const selected = window.getSelection();
  const range = selected?.rangeCount && !selected.isCollapsed ? selected.getRangeAt(0) : null;
  const selecting = range && ($('preview').contains(range.startContainer) || $('preview').contains(range.endContainer) || range.intersectsNode($('preview')));
  return active && !disposed && context?.ready && boundConversation === conversation() && !!model.document &&
    !model.loading && !model.sending && !model.uncertain && !selecting && $('comment-panel').hidden && !$('batch-dialog').open;
}
function syncAutoUpdate() {
  const blocked = !autoAvailable();
  if (blocked !== autoBlocked) {
    autoBlocked = blocked;
    interactionVersion++;
    clearTimeout(autoTimer); autoTimer = undefined;
    if (blocked) autoController?.abort();
    else autoResume = true;
  }
  if (!blocked && !autoPending && autoTimer === undefined) {
    autoTimer = setTimeout(checkFile, autoResume ? 0 : 2000);
    autoResume = false;
  }
}
async function checkFile() {
  autoTimer = undefined;
  if (!autoAvailable() || autoPending) return syncAutoUpdate();
  autoPending = true;
  const target = context;
  const readingModel = model;
  const ticket = { session: model.session, request: model.request };
  const version = interactionVersion;
  const revision = model.revision;
  const path = model.path;
  const requestController = autoController = new AbortController();
  const current = () => autoAvailable() && context === target && model === readingModel && model.path === path &&
    model.current(ticket) && model.revision === revision && interactionVersion === version;
  try {
    const data = await api('/api/read', { path }, { signal: requestController.signal });
    if (!current()) return;
    const recovered = !!model.error;
    const changed = displayRead(ticket, data, true);
    controls();
    if (changed) renderAnnotations();
    if (changed || recovered) cache();
  } catch (error) {
    if (error.name === 'AbortError' || !current()) return;
    if (model.error !== error.message) {
      model.failure(ticket, error.message);
      note(`${error.message} 当前为旧预览。`, true);
      controls();
      cache();
    }
  } finally {
    autoPending = false;
    if (autoController === requestController) autoController = undefined;
    syncAutoUpdate();
  }
}
function snapshot() {
  return { ...model.snapshot($('comment').value, $('batch-instruction').value, readingTop),
    commentOpen: !!model.draft && commentOpen };
}
async function persistSession(target = context, state = snapshot(), keepalive = false) {
  if (!target?.ready || !target.id) return false;
  target.state = state;
  target.pending = { state, keepalive };
  if (target.saving) return target.saving;
  target.saving = (async () => {
    let saved = true;
    while (target.pending) {
      const next = target.pending;
      target.pending = null;
      try {
        const result = await api('/api/session/write', { conversationId: target.id,
          version: target.version, state: next.state }, {
          // ponytail: browser keepalive has a 64 KiB ceiling; larger previews use normal writes during edits.
          keepalive: next.keepalive && new TextEncoder().encode(JSON.stringify(next.state)).length < 60000,
        });
        target.version = result.version;
      } catch (error) {
        saved = false;
        if (target === context && !disposed) note(`状态未缓存：${error.message}`, true);
      }
    }
    return saved;
  })();
  try { return await target.saving; }
  finally { target.saving = null; }
}
function cache() { void persistSession(); }
function restoreComment() {
  $('comment-panel').hidden = !(active && context?.ready && commentOpen && model.draft);
  if ($('comment-panel').hidden) return;
  anchorRange = model.draft.valid && model.draft.revision === model.revision && model.draft.path === model.document?.path
    ? restoreRange($('preview'), model.draft.anchor) : null;
  controls();
  positionOverlays();
  $('comment').focus({ preventScroll: true });
}
function paintDocument(state) {
  releaseImages?.(); releaseImages = undefined;
  const data = model.document;
  $('path').value = model.path;
  $('comment').value = state?.commentText ?? '';
  commentOpen = !!state?.commentOpen && !!model.draft;
  const cursor = context?.commentSelection ?? [$('comment').value.length, $('comment').value.length, 'none'];
  $('comment').setSelectionRange(...cursor);
  $('batch-instruction').value = state?.instruction ?? '';
  $('quote').textContent = model.draft?.quote ?? '';
  $('quote-path').textContent = model.draft?.path ?? '';
  $('file-name').textContent = data?.name ?? '未选择文件';
  $('file-path').textContent = data?.path ?? '';
  $('empty').hidden = !!data?.text;
  $('preview').hidden = !data?.text;
  $('empty-text').textContent = data ? '文件为空。' : '粘贴本地 .md 或 .markdown 完整路径，打开后开始阅读。';
  const rendered = renderMarkdown(data?.text ?? '');
  $('preview').innerHTML = rendered.html;
  diagramSources = rendered.diagrams;
  restoringScroll = true;
  readingTop = state?.scrollTop ?? 0;
  $('reader').scrollTop = readingTop;
  requestAnimationFrame(() => { restoringScroll = false; });
  setHeader(!data && active);
  restoreComment();
  renderBatch();
  note(model.error ? `${model.error}${data ? ' 当前为旧预览。' : ''}` : data ? `已恢复预览 · 已检查 ${new Date(data.checkedAt).toLocaleTimeString()}` : '选择 Markdown 文件。', !!model.error);
  resumeDiagrams();
  resumeImages();
}
function suspend() {
  releaseImages?.(); releaseImages = undefined;
  if (context) context.commentSelection = [$('comment').selectionStart, $('comment').selectionEnd, $('comment').selectionDirection];
  clearTimeout(autoTimer);
  autoTimer = undefined;
  autoController?.abort();
  autoBlocked = true;
  interactionVersion++;
  controller?.abort();
  if (model.pauseRead()) note('读取已暂停，请点击刷新。');
  selection = null;
  anchorRange = null;
  diagramGeneration++;
  hoverHeader = false;
  setHeader(false);
  $('comment-panel').hidden = true;
  $('batch-dialog').close();
  $('link-dialog').close();
  releaseList();
}
async function switchConversation() {
  if (context) { suspend(); cache(); }
  const id = conversation();
  boundConversation = id;
  let target = contexts.get(id);
  if (!target) {
    target = { id, model: new PreviewSession(), state: null, version: 0, ready: false, pending: null, saving: null };
    contexts.set(id, target);
  }
  context = target;
  model = target.model;
  setBatchFeedback();
  diagramGeneration++;
  $('reader').scrollTop = 0;
  paintDocument(target.state);
  if (target.ready) return;
  try {
    const cached = id ? await api('/api/session/read', { conversationId: id }) : { version: 0, state: null };
    target.version = cached.version;
    target.state = cached.state;
    target.model.restore(cached.state);
    target.ready = true;
    if (target !== context || disposed) return;
    paintDocument(cached.state);
    controls();
  } catch (error) {
    if (target === context && !disposed) note(`会话状态未读取：${error.message}。重新打开面板重试。`, true);
  }
}
function resumeDiagrams() {
  if (!active || !model.document || !diagramSources.length) return;
  const target = context;
  const generation = ++diagramGeneration;
  const revision = model.revision;
  const top = readingTop;
  const current = () => active && context === target && model.revision === revision && generation === diagramGeneration;
  void renderDiagrams($('preview'), diagramSources, current, () => {
    if (current()) { $('reader').scrollTop = top; positionOverlays(); }
  }, diagramTheme).catch(() => { if (current()) note('正文已显示，部分图表未能加载。', true); });
}
function controls() {
  if (boundConversation !== conversation()) { void switchConversation(); return; }
  const available = active && !!context?.ready;
  for (const button of $('file-list').children) button.disabled = !available || model.sending;
  const locked = model.sending || model.uncertain;
  $('refresh').disabled = !available || !model.path || model.loading || model.sending;
  $('open').disabled = !available || model.sending;
  $('path').disabled = !available || model.sending;
  $('select-comment').disabled = !available || !selection || locked || model.loading || !!model.error;
  $('add-comment').disabled = locked || !model.canSend(conversation(), available, $('comment').value);
  $('cancel-comment').disabled = model.sending;
  $('comment').disabled = !available || locked;
  $('comment-count').textContent = `${$('comment').value.length} / ${COMMENT_LIMIT}`;
  $('draft-warning').textContent = model.draft && !model.draft.valid ? '引用已失效，请在当前正文重新选择。评论文字已保留。' :
    model.draft && model.draft.conversationId !== conversation() ? '目标会话已变化，请重新开始评论。' :
    $('comment').value.length > COMMENT_LIMIT ? '评论超过 4,000 字符，请缩短后加入。' : '';
  $('floating-comment').hidden = !active || !selection || locked || model.loading || !!model.error || !$('comment-panel').hidden;
  $('resume-comment').hidden = !model.draft;
  $('resume-comment').disabled = !available || locked;
  $('batch-count').textContent = model.comments.length;
  $('show-batch').setAttribute('aria-label', `待发送 ${model.comments.length} 条评论`);
  $('show-batch').classList.toggle('has-comments', model.comments.length > 0);
  $('show-batch').disabled = !available;
  const instruction = $('batch-instruction').value;
  $('send-batch').disabled = !!model.batchError(conversation(), available, instruction);
  $('clear-batch').disabled = locked || !model.comments.length;
  $('batch-instruction').disabled = locked;
  $('unlock-batch').hidden = !model.uncertain;
  $('batch-warning').textContent = !model.comments.length && batchFeedback ? batchFeedback : model.batchError(conversation(), active, instruction) || batchFeedback;
  const length = batchMessage(model.comments, instruction).length;
  $('batch-size').textContent = `整批 ${length} / ${MESSAGE_LIMIT} 字符 · 指令 ${instruction.length} / ${COMMENT_LIMIT}`;
  $('batch-status').textContent = model.sending ? '正在统一发送…' :
    model.uncertain ? '发送结果未确认，请先检查主会话，不自动重发。' : batchFeedback;
  $('batch-status').hidden = !$('batch-status').textContent;
  $('batch-status').classList.toggle('error', model.uncertain || !!(model.comments.length && batchFeedback));
  for (const [index, item] of model.comments.entries()) {
    const row = $('batch-list').children[index];
    if (!row) continue;
    row.querySelector('textarea').disabled = locked;
    row.querySelector('textarea').setAttribute('aria-invalid', String(!item.comment.trim() || item.comment.length > COMMENT_LIMIT));
    row.querySelector('button').disabled = locked;
    row.querySelector('.source-warning').hidden = !item.sourceChanged;
    row.querySelector('.item-count').textContent = `${item.comment.length} / ${COMMENT_LIMIT}`;
  }
  for (const button of $('comment-markers').children) button.disabled = !available || locked;
  positionCommentMarkers();
  syncAutoUpdate();
}
function resumeImages(ratio) {
  releaseImages?.(); releaseImages = undefined;
  if (!active || !model.document || !bridge) return;
  const target = context;
  const document = model.document;
  const top = readingTop;
  let expected = $('reader').scrollTop;
  let follow = true;
  releaseImages = loadImages($('preview'), document.path, (...args) => bridge.fetch(...args), () => {
    if (!active || context !== target || model.document?.path !== document.path) return;
    const reader = $('reader');
    if (Math.abs(reader.scrollTop - expected) > 2) follow = false;
    if (follow) {
      restoringScroll = true;
      reader.scrollTop = ratio === undefined ? top : ratio * Math.max(0, reader.scrollHeight - reader.clientHeight);
      readingTop = expected = reader.scrollTop;
      requestAnimationFrame(() => { restoringScroll = false; });
    }
    positionOverlays();
  });
}
function setHeader(expanded) {
  const opening = expanded && $('header-content').hidden;
  if (!expanded) $('typography').open = false;
  $('header-content').hidden = !expanded;
  $('settings-toggle').setAttribute('aria-expanded', String(expanded));
  $('settings-toggle').setAttribute('aria-label', '面板设置');
  positionOverlays();
  if (opening && active && workspaceReady) void loadFiles(true);
}
function collapseHeader() {
  if (model.document && !hoverHeader && !$('header').contains(document.activeElement)) setHeader(false);
}
function renderBatch() {
  $('batch-list').replaceChildren();
  model.comments.forEach((item, index) => {
    const row = document.createElement('details');
    row.className = 'batch-item';
    const summary = document.createElement('summary');
    summary.textContent = `评论 ${index + 1}`;
    const details = document.createElement('details');
    const title = document.createElement('summary');
    title.textContent = '查看引用';
    const quote = document.createElement('blockquote');
    quote.textContent = item.quote;
    details.append(title, quote);
    const warning = document.createElement('p');
    warning.className = 'source-warning';
    warning.textContent = '来源已变化或读取失败，发送时将使用加入时的引用快照。';
    const label = document.createElement('label');
    label.htmlFor = `batch-comment-${index}`;
    label.textContent = `评论 ${index + 1}`;
    const input = document.createElement('textarea');
    input.id = label.htmlFor;
    input.rows = 2;
    input.maxLength = COMMENT_LIMIT;
    input.value = item.comment;
    input.dataset.index = index;
    const actions = document.createElement('div');
    actions.className = 'comment-actions';
    const count = document.createElement('span');
    count.className = 'muted item-count';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '删除';
    remove.dataset.index = index;
    remove.setAttribute('aria-label', `删除评论 ${index + 1}`);
    actions.append(count, remove);
    row.append(summary, details, warning, label, input, actions);
    $('batch-list').append(row);
  });
  renderAnnotations();
  controls();
}
function renderAnnotations() {
  $('comment-markers').replaceChildren();
  commentRanges = [];
  for (const [index, item] of model.comments.entries()) {
    if (item.revision !== model.revision || item.path !== model.document?.path) continue;
    const range = restoreRange($('preview'), item.anchor);
    if (!range) continue;
    commentRanges.push({ range, index });
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.index = index;
    button.className = 'comment-marker';
    button.setAttribute('aria-label', `修改评论 ${index + 1}`);
    button.title = `修改评论 ${index + 1}`;
    button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6Z"/><path d="m14 5 5 5"/></svg>';
    $('comment-markers').append(button);
  }
  if (CSS.highlights) CSS.highlights.set('comments', new Highlight(...commentRanges.map(item => item.range)));
  positionCommentMarkers();
}
function positionCommentMarkers() {
  const reader = $('reader');
  const bounds = reader.getBoundingClientRect();
  const top = Math.max(bounds.top, $('header').getBoundingClientRect().bottom) + 4;
  const bottom = bounds.bottom - 4;
  const right = bounds.left + reader.clientWidth - 34;
  const visible = [];
  commentRanges.forEach(({ range }, offset) => {
    const button = $('comment-markers').children[offset];
    const rect = [...range.getClientRects()].findLast(rect => rect.width && rect.height);
    button.hidden = !active || !range.startContainer.isConnected || !rect || rect.bottom < top || rect.top > bottom;
    if (!button.hidden) visible.push({ button, top: Math.max(top, Math.min(rect.top, bottom - 28)) });
  });
  visible.sort((a, b) => a.top - b.top);
  let next = top;
  for (const item of visible) { item.top = Math.max(item.top, next); next = item.top + 32; }
  let limit = bottom - 28;
  for (const item of visible.toReversed()) {
    item.top = Math.min(item.top, limit);
    item.button.hidden = item.top < top;
    item.button.style.left = `${right}px`;
    item.button.style.top = `${item.top}px`;
    limit = item.top - 32;
  }
}
function positionOverlays() {
  positionCommentMarkers();
  const range = !$('comment-panel').hidden ? anchorRange : selection?.range;
  if (!range && $('comment-panel').hidden) return;
  const connected = range?.startContainer.isConnected;
  const rects = connected ? [...range.getClientRects()] : [];
  const edge = $('settings-toggle').getBoundingClientRect().bottom + 8;
  const rect = rects.findLast(r => r.bottom >= edge && r.top < innerHeight) ?? (connected ? range.getBoundingClientRect() : { left: 8, bottom: edge });
  const left = Math.max(8, Math.min(rect.left, innerWidth - 80));
  const buttonTop = Math.max(edge, Math.min(rect.bottom + 6, innerHeight - 44));
  $('floating-comment').style.left = `${left}px`;
  $('floating-comment').style.top = `${buttonTop}px`;
  if (!$('comment-panel').hidden) {
    const panel = $('comment-panel');
    const height = panel.getBoundingClientRect().height;
    const width = panel.getBoundingClientRect().width;
    const below = buttonTop + 36;
    const top = below + height <= innerHeight - 8 ? below : buttonTop - height - 6;
    panel.style.left = `${Math.max(8, Math.min(left, innerWidth - width - 8))}px`;
    panel.style.top = `${Math.max(edge, Math.min(top, innerHeight - height - 8))}px`;
  }
}
function applySettings() {
  document.documentElement.style.setProperty('--reader-font-size', `${prefs.fontSize}px`);
  document.documentElement.style.setProperty('--reader-line-height', String(prefs.lineHeight));
  document.documentElement.dataset.colorMode = prefs.colorMode;
  $('color-mode').value = prefs.colorMode;
  $('font-size').value = prefs.fontSize;
  $('line-height').value = prefs.lineHeight;
  $('font-size-value').textContent = `${prefs.fontSize} px`;
  $('line-height-value').textContent = prefs.lineHeight.toFixed(1);
  positionOverlays();
}
function refreshDiagramTheme() {
  const rgb = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
  const theme = rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 < 128 ? 'dark' : 'neutral';
  const scheme = theme === 'dark' ? 'dark' : 'light';
  if (document.documentElement.style.colorScheme !== scheme) document.documentElement.style.colorScheme = scheme;
  if (theme === diagramTheme) return;
  diagramTheme = theme;
  if (!active || !model.document || !diagramSources.length) return;
  resumeDiagrams();
}
async function persistSettings() {
  pendingSettings = { ...prefs };
  if (savingSettings) return;
  savingSettings = true;
  while (pendingSettings) {
    const next = pendingSettings;
    pendingSettings = null;
    try { await api('/api/settings/write', next); if (active) $('settings-status').textContent = '面板设置已保存。'; }
    catch { if (active) $('settings-status').textContent = '未保存，当前设置仍有效。'; }
  }
  savingSettings = false;
}
function invalidateSelection() { selection = null; $('floating-comment').hidden = true; controls(); }
function setActive(value) {
  value &&= !document.hidden;
  if (active === value) return;
  active = value;
  if (!active) {
    suspend();
    cache();
  }
  if (active) {
    if (boundConversation !== conversation()) { void switchConversation(); return; }
    restoringScroll = true;
    $('reader').scrollTop = readingTop;
    requestAnimationFrame(() => { restoringScroll = false; });
    if (!model.document) setHeader(true);
    if (workspaceReady && !$('header-content').hidden) void loadFiles(true);
    if (context?.commentSelection) $('comment').setSelectionRange(...context.commentSelection);
    restoreComment();
    renderBatch();
    resumeDiagrams();
    resumeImages();
  }
  else controls();
}
let intersecting = false;
const visibility = new IntersectionObserver(entries => {
  intersecting = entries[0].isIntersecting;
  setActive(intersecting);
});
visibility.observe(document.documentElement);
on(document, 'visibilitychange', () => setActive(intersecting));
on(window, 'pagehide', () => {
  active = false;
  disposed = true;
  clearTimeout(feedbackTimer);
  suspend();
  clearTimeout(scrollTimer);
  workspaceUnsubscribe?.();
  void persistSession(context, snapshot(), true);
  visibility.disconnect();
  events.abort();
});

async function read(path) {
  if (!active || !context?.ready || model.sending) return;
  const target = context;
  const readingModel = model;
  autoController?.abort();
  interactionVersion++;
  path = path.trim().replace(/^"(.*)"$/, '$1');
  const previous = model.document;
  const sameFile = previous?.path.toLowerCase() === path.toLowerCase();
  let ticket;
  try { ticket = model.begin(path); } catch (error) { note(error.message, true); return; }
  invalidateSelection();
  controller?.abort();
  controller = new AbortController();
  if (!sameFile) {
    releaseImages?.(); releaseImages = undefined;
    $('preview').replaceChildren();
    $('preview').hidden = true;
    $('empty').hidden = false;
    $('empty-text').textContent = '正在打开文件…';
    $('file-name').textContent = '正在打开';
    $('file-path').textContent = '';
  }
  note('正在读取…');
  controls();
  try {
    const data = await api('/api/read', { path }, { signal: controller.signal });
    if (!active || context !== target || !readingModel.current(ticket)) return;
    displayRead(ticket, data, sameFile, true);
    $('reader').focus({ preventScroll: true }); setHeader(false);
  } catch (error) {
    if (error.name === 'AbortError' || !active || context !== target || !readingModel.current(ticket)) return;
    model.failure(ticket, error.message);
    if (!model.document) { $('empty').hidden = false; $('empty-text').textContent = error.message; $('file-name').textContent = '打开失败'; }
    note(`${error.message}${model.document ? ' 当前为旧预览。' : ''}`, true);
  } finally { if (context === target && readingModel.current(ticket)) { renderAnnotations(); controls(); cache(); } }
}

function displayRead(ticket, data, sameFile, refreshImages = false) {
  const target = context;
  const changed = !model.document || model.document.text !== data.text || model.document.path.toLowerCase() !== data.path.toLowerCase();
  const rendered = changed ? renderMarkdown(data.text) : null;
  const ratio = sameFile && $('reader').scrollHeight > $('reader').clientHeight ? $('reader').scrollTop / ($('reader').scrollHeight - $('reader').clientHeight) : 0;
  model.success(ticket, data);
  $('file-name').textContent = data.name;
  $('file-path').textContent = data.path;
  $('path').value = data.path;
  $('empty').hidden = !!data.text;
  $('empty-text').textContent = '文件为空。';
  $('preview').hidden = !data.text;
  if (changed) {
    releaseImages?.(); releaseImages = undefined;
    invalidateSelection();
    anchorRange = null;
    $('preview').innerHTML = rendered.html;
    diagramSources = rendered.diagrams;
    const generation = ++diagramGeneration;
    const revision = model.revision;
    const current = () => active && context === target && model.revision === revision && generation === diagramGeneration;
    const restore = () => { if (current()) {
      readingTop = ratio * Math.max(0, $('reader').scrollHeight - $('reader').clientHeight);
      $('reader').scrollTop = readingTop;
      positionOverlays();
    } };
    restore();
    void renderDiagrams($('preview'), rendered.diagrams, current, restore, diagramTheme).catch(() => {
      if (current()) note('正文已显示，部分图表未能加载。', true);
    });
  }
  if (changed || refreshImages) resumeImages(ratio);
  note(`已检查 ${new Date(data.checkedAt).toLocaleTimeString()}`);
  return changed;
}

function captureSelection() {
  selection = null;
  const selected = window.getSelection();
  if (!active || !model.document || model.loading || model.error || !selected?.rangeCount || selected.isCollapsed) return controls();
  const range = selected.getRangeAt(0);
  if (!$('preview').contains(range.startContainer) || !$('preview').contains(range.endContainer)) return controls();
  if ([...$('preview').querySelectorAll('[data-no-comment]')].some(node => range.intersectsNode(node))) return controls();
  const text = selected.toString();
  if (!text.trim()) return controls();
  selection = { text, revision: model.revision, range: range.cloneRange() };
  positionOverlays();
  controls();
}
function startComment() {
  if (!selection || selection.revision !== model.revision || model.sending) return;
  if (selection.text.length > QUOTE_LIMIT) return note('引用超过 8,000 字符，请缩小选区。', true);
  if (model.draft?.valid && $('comment').value.trim()) { note('请先加入或取消当前评论；可通过“继续草稿”恢复。', true); return; }
  try { model.selectQuote(selection.text, conversation(), saveRange($('preview'), selection.range)); }
  catch (error) { return note(error.message, true); }
  $('quote').textContent = selection.text;
  $('quote-path').textContent = model.draft.path;
  anchorRange = selection.range;
  commentOpen = true;
  $('comment-panel').hidden = false;
  positionOverlays();
  $('floating-comment').hidden = true;
  selection = null;
  $('comment').focus();
  controls();
  cache();
}
function closeComment(clear = false) {
  if (model.sending) return;
  commentOpen = false;
  if (clear) { model.draft = null; $('comment').value = ''; $('quote').textContent = ''; anchorRange = null; }
  $('comment-panel').hidden = true;
  $('reader').focus({ preventScroll: true });
  controls();
  cache();
}
function addComment(event) {
  event.preventDefault();
  try { model.addComment(conversation(), active, $('comment').value); }
  catch (error) { note(error.message, true); return; }
  closeComment(true);
  window.getSelection()?.removeAllRanges();
  setBatchFeedback();
  renderBatch();
  note(`已加入 ${model.comments.length} 条评论，尚未发送。`);
  cache();
}
async function sendBatch(event) {
  event.preventDefault();
  controls();
  if (model.batchError(conversation(), active, $('batch-instruction').value)) return;
  const target = context;
  if (!active || !target?.ready) return;
  const sendingModel = model;
  const before = snapshot();
  setBatchFeedback();
  const pending = sendingModel.sendBatch(async (message, id) => {
    const saved = await persistSession(target, { ...before, sending: true });
    if (!saved || disposed || !active || context !== target || id !== conversation()) return { error: '发送前状态未保存或面板已隐藏。' };
    return bridge.agent.sendMessage(message, id);
  }, target.id, active, before.instruction);
  $('batch-dialog').close();
  $('reader').focus({ preventScroll: true });
  controls();
  const result = await pending;
  const state = { ...(target.state ?? before), ...sendingModel.snapshot(
    (target.state ?? before).commentText, result === 'sent' ? '' : before.instruction,
    (target.state ?? before).scrollTop) };
  await persistSession(target, state);
  if (context !== target || disposed) return;
  if (result === 'sent') {
    $('batch-instruction').value = '';
    setBatchFeedback('评论已统一发送。可在主会话展开 Message from System 查看。', true);
    renderBatch();
    $('batch-warning').textContent = batchFeedback;
  } else {
    setBatchFeedback(result === 'rejected' ? '宿主拒绝发送，评论已保留，可修改后重试。' : '发送结果未确认，请先检查主会话，不自动重发。');
    controls();
  }
  note(batchFeedback, result !== 'sent');
}

on($('open-form'), 'submit', event => { event.preventDefault(); void read($('path').value); });
on($('refresh'), 'click', () => void read(model.path));
on($('file-list'), 'click', event => { const button = event.target.closest('button[data-path]'); if (button) void read(button.dataset.path); });
on($('file-list'), 'scroll', () => {
  const list = $('file-list');
  if (list.scrollHeight > list.clientHeight && list.scrollTop + list.clientHeight >= list.scrollHeight - 12) void loadFiles(false, true);
});
on($('files-more'), 'click', () => void loadFiles(false, true));
on($('files-retry'), 'click', () => void loadFiles(true));
on($('file-search'), 'input', () => {
  clearTimeout(searchTimer); listController?.abort(); listGeneration++; listBusy = false;
  listOffset = null; $('files-more').hidden = true;
  searchTimer = setTimeout(() => void loadFiles(), 300);
});
on($('font-size'), 'input', () => { prefs.fontSize = Number($('font-size').value); prefsChanged++; applySettings(); });
on($('line-height'), 'input', () => { prefs.lineHeight = Number($('line-height').value); prefsChanged++; applySettings(); });
on($('font-size'), 'change', () => void persistSettings());
on($('line-height'), 'change', () => void persistSettings());
on(document, 'selectionchange', captureSelection);
on(document, 'pointerdown', event => { if (!$('comment-panel').hidden && !event.target.closest('#comment-panel, #floating-comment, #select-comment')) closeComment(); });
on($('floating-comment'), 'mousedown', event => event.preventDefault());
on($('select-comment'), 'mousedown', event => event.preventDefault());
on($('floating-comment'), 'click', startComment);
on($('select-comment'), 'click', startComment);
on($('comment'), 'input', () => { controls(); cache(); });
on($('comment-form'), 'submit', addComment);
on($('cancel-comment'), 'click', () => closeComment(true));
on($('resume-comment'), 'click', () => { if (!model.draft) return; $('reader').focus({ preventScroll: true }); setHeader(false); commentOpen = true; restoreComment(); cache(); });
on($('header'), 'pointerenter', () => { hoverHeader = true; setHeader(true); });
on($('header'), 'pointerleave', () => { hoverHeader = false; collapseHeader(); });
on($('header'), 'focusout', () => queueMicrotask(collapseHeader));
on($('header'), 'focusin', () => setHeader(true));
on($('settings-toggle'), 'click', () => setHeader(true));
on($('color-mode'), 'change', () => { prefs.colorMode = $('color-mode').value; prefsChanged++; applySettings(); void persistSettings(); });
on($('show-batch'), 'click', () => { renderBatch(); $('batch-dialog').showModal(); controls(); });
on($('comment-markers'), 'click', event => {
  const button = event.target.closest('button[data-index]');
  if (!button || !active || model.sending || model.uncertain) return;
  const index = Number(button.dataset.index);
  closeComment();
  renderBatch();
  $('batch-dialog').showModal();
  const input = $(`batch-comment-${index}`);
  input.closest('.batch-item').open = true;
  input.scrollIntoView({ block: 'center' });
  input.focus({ preventScroll: true });
  controls();
});
on($('close-batch'), 'click', () => $('batch-dialog').close());
on($('batch-dialog'), 'close', controls);
on($('clear-batch'), 'click', () => { model.clearComments(); $('batch-instruction').value = ''; setBatchFeedback(); renderBatch(); cache(); });
on($('batch-list'), 'input', event => { if (!event.target.matches('textarea')) return; model.updateComment(Number(event.target.dataset.index), event.target.value); setBatchFeedback(); controls(); cache(); });
on($('batch-list'), 'click', event => { const button = event.target.closest('button[data-index]'); if (!button || model.sending || model.uncertain) return; model.removeComment(Number(button.dataset.index)); setBatchFeedback(); renderBatch(); $('clear-batch').focus(); cache(); });
on($('batch-instruction'), 'input', () => { setBatchFeedback(); controls(); cache(); });
on($('batch-form'), 'submit', sendBatch);
for (const [formId, buttonId, isOpen] of [
  ['comment-form', 'add-comment', () => !$('comment-panel').hidden],
  ['batch-form', 'send-batch', () => $('batch-dialog').open],
]) {
  on($(formId), 'keydown', event => {
    if (event.key !== 'Enter' || !event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.isComposing || event.repeat || !isOpen()) return;
    event.preventDefault();
    controls();
    if (!$(buttonId).disabled) $(formId).requestSubmit($(buttonId));
  });
}
on($('unlock-batch'), 'click', () => { model.uncertain = false; setBatchFeedback('已解锁。再次发送可能产生重复评论，请确认主会话尚未收到。'); controls(); cache(); });
on(document, 'keydown', event => {
  if (event.key !== 'Escape' || $('batch-dialog').open || $('link-dialog').open) return;
  if (!$('comment-panel').hidden) { event.preventDefault(); closeComment(); }
  else if (!$('header-content').hidden && model.document) { $('reader').focus({ preventScroll: true }); setHeader(false); }
});
on($('reader'), 'scroll', () => {
  positionOverlays();
  if (restoringScroll || !active || !context?.ready) return;
  readingTop = $('reader').scrollTop;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(cache, 120);
});
on(window, 'resize', positionOverlays);
const overlaySize = new ResizeObserver(positionOverlays);
overlaySize.observe($('comment-panel'));
overlaySize.observe($('preview'));
overlaySize.observe($('header'));
overlaySize.observe($('reader'));
const themeChanges = new MutationObserver(refreshDiagramTheme);
themeChanges.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-color-mode'] });
on(window, 'pagehide', () => { overlaySize.disconnect(); themeChanges.disconnect(); });
on($('preview'), 'click', async event => {
  const button = event.target.closest('[data-copy-url]');
  if (!button) return;
  const url = button.dataset.copyUrl;
  try { await navigator.clipboard.writeText(url); note('链接地址已复制。'); }
  catch { $('link-url').value = url; $('link-dialog').showModal(); $('link-url').select(); }
});
on($('close-link'), 'click', () => $('link-dialog').close());
applySettings();
refreshDiagramTheme();
controls();
if (!bridge) note('宿主桥接不可用，请从 Antigravity Extensions 打开 ClearPane。', true);
else {
  void switchConversation();
  if (bridge.onWorkspaceChange) workspaceUnsubscribe = bridge.onWorkspaceChange(updateWorkspaces);
  if (bridge.getWorkspaceUris) bridge.getWorkspaceUris().then(updateWorkspaces).catch(() => {
    $('file-list-status').textContent = '工作区信息未读取，仍可粘贴文件路径。';
  });
  else updateWorkspaces([]);
  api('/api/settings/read', {}).then(data => {
    if (!prefsChanged) { const top = $('reader').scrollTop; prefs = data; applySettings(); $('reader').scrollTop = top; }
  }).catch(() => { $('settings-status').textContent = '设置未读取，使用默认排版。'; });
}

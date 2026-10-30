import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, mkdtemp, mkdir, writeFile, rm, rename, utimes } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WorkspaceFiles } from '../plugin/sidecars/panel/workspace-files.mjs';
import { readMarkdown } from '../plugin/sidecars/panel/files.mjs';

const run = promisify(execFile);
const browser = process.env.AGENT_BROWSER_BIN || join(homedir(), 'AppData/Roaming/npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe');
const panel = new URL('../plugin/sidecars/panel/', import.meta.url);

test('workspace list and automatic saved-file updates protect reading, selections, drafts and hidden panes', { timeout: 180000 }, async t => {
  try { await access(browser); await access(new URL('assets/app.js', panel)); }
  catch { t.skip('Build assets and install agent-browser to run the browser check'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'clearpane-workspace-ui-'));
  const root = join(directory, '工作区');
  await mkdir(join(root, 'nested'), { recursive: true });
  const article = suffix => '# 测试文章\n\n' + '正文可选评论\n\n'.repeat(60) + suffix;
  for (let i = 0; i < 7; i++) {
    const file = join(root, i === 0 ? 'nested' : '', `${i} 中文.md`);
    await writeFile(file, article('saved A'));
    await utimes(file, new Date(10000 + i * 1000), new Date(10000 + i * 1000));
  }
  const currentFile = join(root, '6 中文.md');
  const outside = join(directory, 'outside.md');
  await writeFile(outside, '# 外部文件');
  const lists = new WorkspaceFiles();
  const states = new Map();
  const preload = `
    const qa = window.qa = { reads: 0, writes: 0, sends: 0, hold: false, finish: null, workspace: ${JSON.stringify(pathToFileURL(root).href)} };
    const nativeFetch = window.fetch.bind(window);
    window.sidecar = { conversationId: 'A', getWorkspaceUris: async () => [qa.workspace],
      onWorkspaceChange: callback => { qa.workspaceChange = callback; return () => { qa.workspaceChange = null; }; },
      fetch: async (url, options) => {
        if (url === '/api/read') qa.reads++;
        if (url === '/api/session/write') qa.writes++;
        const response = await nativeFetch(url, { ...options, headers: { 'Content-Type': 'application/json' } });
        if (url === '/api/read' && qa.hold) { qa.hold = false; await new Promise(resolve => { qa.finish = resolve; }); }
        return response;
      }, agent: { sendMessage: async () => { qa.sends++; return {}; } } };
  `;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/preload.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(preload); return; }
      if (request.method === 'POST') {
        let raw = ''; for await (const bytes of request) raw += bytes;
        const body = JSON.parse(raw);
        let data;
        if (url.pathname === '/api/files/list') data = await lists.list(body);
        else if (url.pathname === '/api/read') data = await readMarkdown(body.path);
        else if (url.pathname === '/api/settings/read') data = { fontSize: 16, lineHeight: 1.8, colorMode: 'light' };
        else if (url.pathname === '/api/settings/write') data = body;
        else if (url.pathname === '/api/session/read') data = states.get(body.conversationId) ?? { version: 0, state: null };
        else if (url.pathname === '/api/session/write') {
          states.set(body.conversationId, { version: body.version + 1, state: body.state }); data = { version: body.version + 1 };
        }
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data)); return;
      }
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^(index\.html|styles\.css|assets\/[\w.-]+)$/.test(name)) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(await readFile(new URL(name, panel)));
    } catch (error) { response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const session = 'clearpane-workspace-' + randomUUID();
  const command = async (...args) => (await run(browser, ['--session', session, ...args], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout;
  const evaluate = async code => {
    let output;
    try { output = await command('eval', '-b', Buffer.from(`(async () => {
      const $ = id => document.getElementById(id);
      const check = (value, message) => { if (!value) throw new Error(message); };
      const wait = async check => { for (let i = 0; i < 160; i++) { if (check()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('UI wait timed out'); };
      const select = () => { const node = $('preview').querySelector('p').firstChild; const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 2); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); document.dispatchEvent(new Event('selectionchange')); };
      ${code}
      return 'ok'; })()`).toString('base64')); }
    catch (error) { throw new Error(error.stderr || error.message.slice(0, 200)); }
    assert.match(output, /"ok"/);
  };
  try {
    await command('open', `http://127.0.0.1:${server.address().port}`);
    await evaluate(`await wait(() => $('file-list').children.length === 3 && !$('open').disabled);
      check($('file-list').children[0].textContent.includes('6 中文'), 'sort');
      check($('file-list').clientHeight === 102, 'three row height');
      check([...$('file-list').children].every(button => button.children.length === 1 && button.title), 'one filename with path tooltip');
      $('files-more').focus();`);
    await command('press', 'Enter');
    await evaluate(`await wait(() => $('file-list').children.length === 6);
      $('file-list').scrollTop = $('file-list').scrollHeight; $('file-list').dispatchEvent(new Event('scroll'));
      await wait(() => $('file-list').children.length === 7);
      $('file-search').value = 'NESTED'; $('file-search').dispatchEvent(new Event('input'));
      await wait(() => $('file-list').children.length === 1);
      check($('file-list').textContent.includes('0 中文'), 'search entire workspace');
      $('file-search').value = 'absent'; $('file-search').dispatchEvent(new Event('input'));
      await wait(() => $('file-list-status').textContent.includes('没有匹配'));
      $('file-search').value = ''; $('file-search').dispatchEvent(new Event('input'));
      await wait(() => $('file-list').children.length === 3);
      $('file-list').firstChild.click();
      await wait(() => $('preview').textContent.includes('saved A'));
      check($('header-content').hidden, 'successful list open collapses header');
      $('reader').scrollTop = 180; window.beforeTop = $('reader').scrollTop;
      select(); $('floating-comment').click(); $('comment').value = '意见'; $('comment-form').requestSubmit();
      await wait(() => $('batch-count').textContent === '1');
      window.beforePreview = $('preview').firstChild;
      await new Promise(r => setTimeout(r, 300));
      window.beforeWrites = qa.writes; window.beforeReads = qa.reads;
      await wait(() => qa.reads > beforeReads);
      check($('preview').firstChild === beforePreview && CSS.highlights.get('comments').size === 1, 'unchanged rebuilt or lost highlight');
      check($('reader').scrollTop === beforeTop, 'unchanged scroll');
      check(qa.writes === beforeWrites, 'unchanged cached full snapshot');`);
    await evaluate(`$('comment-markers').firstElementChild.click(); window.beforeReads = qa.reads;
      check(!$('edit-comment-panel').hidden && !$('batch-dialog').open, 'single edit did not open');`);
    await writeFile(currentFile, article('saved B'));
    await evaluate(`await new Promise(r => setTimeout(r, 2200));
      check(qa.reads === beforeReads && !$('preview').textContent.includes('saved B'), 'single edit did not pause polling');
      $('edit-comment-panel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
    await evaluate(`await wait(() => $('preview').textContent.includes('saved B'));
      check($('batch-count').textContent === '1' && CSS.highlights.get('comments').size === 0, 'changed comments');
      check(Math.abs($('reader').scrollTop - beforeTop) < 3, 'changed scroll');
      $('show-batch').click(); check(!$('batch-list').querySelector('.source-warning').hidden, 'source warning');
      $('clear-batch').click(); $('close-batch').click();
      select(); $('floating-comment').click(); $('comment').value = '保留草稿'; $('comment').dispatchEvent(new Event('input'));
      $('comment-panel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      window.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange'));`);
    const replacement = join(root, 'replacement.md');
    await writeFile(replacement, article('saved C')); await rename(replacement, currentFile);
    await evaluate(`await wait(() => $('preview').textContent.includes('saved C'));
      check($('comment').value === '保留草稿' && $('draft-warning').textContent.includes('失效'), 'draft lost');
      $('resume-comment').click(); $('cancel-comment').click();
      window.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange'));
      qa.hold = true; await wait(() => qa.finish); select();`);
    await writeFile(currentFile, article('saved D'));
    await evaluate(`const before = $('preview').textContent; const beforeReads = qa.reads;
      qa.finish(); qa.finish = null; await new Promise(r => setTimeout(r, 2200));
      check($('preview').textContent === before && qa.reads === beforeReads, 'selection overwritten or polling not paused');
      window.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange'));
      await wait(() => $('preview').textContent.includes('saved D'));
      select(); $('floating-comment').click(); $('comment').value = '编辑中\\n继续中文评论'; $('comment').dispatchEvent(new Event('input'));
      $('comment').setSelectionRange(2, 4, 'backward'); window.beforeReads = qa.reads;
      Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
      await wait(() => $('open').disabled);
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));
      await wait(() => !$('open').disabled);
      check(!$('comment-panel').hidden && document.activeElement === $('comment'), 'return did not restore editor');
      check($('comment').value === '编辑中\\n继续中文评论' && $('quote').textContent === '正文', 'return lost draft or quote');
      check($('comment').selectionStart === 2 && $('comment').selectionEnd === 4 && $('comment').selectionDirection === 'backward', 'return lost cursor');
      window.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange'));
      document.documentElement.style.display = 'none'; await wait(() => $('open').disabled);
      document.documentElement.style.display = ''; await wait(() => !$('open').disabled);
      check(!$('comment-panel').hidden && !$('add-comment').disabled, 'hidden pane did not restore valid draft');
      window.sidecar.conversationId = 'B'; $('comment').dispatchEvent(new Event('input'));
      await wait(() => !$('open').disabled && $('preview').hidden);
      check($('comment-panel').hidden && !$('comment').value, 'B received A draft');
      window.sidecar.conversationId = 'A'; $('comment').dispatchEvent(new Event('input'));
      await wait(() => !$('comment-panel').hidden);
      check($('comment').value === '编辑中\\n继续中文评论' && $('comment').selectionStart === 2, 'conversation return lost draft or cursor');`);
    await writeFile(currentFile, article('saved E'));
    await command('reload');
    await evaluate(`await wait(() => !$('open').disabled && !$('comment-panel').hidden);
      check($('comment').value === '编辑中\\n继续中文评论' && $('quote').textContent === '正文', 'recreation lost draft');
      check(document.activeElement === $('comment') && $('comment').selectionStart === $('comment').value.length, 'recreation did not focus draft end');
      check(!$('add-comment').disabled, 'recreation lost valid quote');
      const beforeReads = qa.reads;
      await new Promise(r => setTimeout(r, 2200)); check(qa.reads === beforeReads && $('preview').textContent.includes('saved D'), 'comment editing pause');
      $('comment-panel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.documentElement.style.display = 'none'; await wait(() => $('open').disabled);
      document.documentElement.style.display = ''; await wait(() => !$('open').disabled);
      check($('comment-panel').hidden && $('comment').value.includes('中文评论'), 'Esc draft reopened or disappeared');
      $('resume-comment').click();
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      check($('comment-panel').hidden, 'outside click did not collapse draft');
      $('resume-comment').click();
      $('cancel-comment').click(); window.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange'));
      document.documentElement.style.display = 'none'; await wait(() => $('open').disabled);
      document.documentElement.style.display = ''; await wait(() => !$('open').disabled);
      check($('comment-panel').hidden && !$('comment').value && $('resume-comment').hidden, 'cancelled draft returned');
      await wait(() => $('preview').textContent.includes('saved E'));
      $('settings-toggle').click(); $('show-batch').click(); window.beforeReads = qa.reads;`);
    await writeFile(currentFile, article('saved F'));
    await evaluate(`await new Promise(r => setTimeout(r, 2200)); check(qa.reads === beforeReads, 'batch pause'); $('close-batch').click();
      await wait(() => $('preview').textContent.includes('saved F'));
      document.documentElement.style.display = 'none'; await new Promise(r => setTimeout(r, 150)); window.beforeReads = qa.reads;`);
    await writeFile(currentFile, article('saved G'));
    await evaluate(`await new Promise(r => setTimeout(r, 2200)); check(qa.reads === beforeReads, 'hidden polling');
      document.documentElement.style.display = ''; await wait(() => $('preview').textContent.includes('saved G'));`);
    await rm(currentFile);
    await evaluate(`await wait(() => $('status').textContent.includes('旧预览'));
      check($('preview').textContent.includes('saved G'), 'error lost content'); window.beforeWrites = qa.writes;
      window.beforeReads = qa.reads; await wait(() => qa.reads > beforeReads);
      check(qa.writes === beforeWrites, 'repeated failure cached');`);
    await writeFile(currentFile, article('rebuilt'));
    await evaluate(`await wait(() => $('preview').textContent.includes('rebuilt') && !$('status').classList.contains('error'));
      qa.hold = true; await wait(() => qa.finish);
      $('settings-toggle').click(); $('path').value = ${JSON.stringify(outside)}; $('open-form').requestSubmit();
      await wait(() => $('preview').textContent.includes('外部文件')); qa.finish(); qa.finish = null;
      await new Promise(r => setTimeout(r, 100)); check($('preview').textContent.includes('外部文件'), 'late old file overwrote new file');
      $('settings-toggle').click(); qa.workspaceChange([]);
      await wait(() => $('file-list-status').textContent.includes('没有工作区'));
      check($('preview').textContent.includes('外部文件'), 'workspace change switched article');
      qa.workspaceChange([qa.workspace]); await wait(() => $('file-list').children.length === 3);
      check(qa.sends === 0, 'sent real messages');`);
    const properties = 'title: 财经UP主报告\ntopics:\n  - 宏观回测\n  - 预测准确率\nsource: ' + 'CLS同学'.repeat(40) + '\n';
    await writeFile(outside, '---\n' + properties + '---\n\n# 报告\n\n正文可选评论\n\n' + '后续正文\n\n'.repeat(60));
    await evaluate(`await wait(() => $('preview').querySelector('.frontmatter'));
      const details = $('preview').querySelector('.frontmatter');
      check(!details.open && details.querySelector('summary').textContent === '文档属性', 'frontmatter not collapsed');
      check(details.querySelector('code').textContent === ${JSON.stringify(properties)}, 'YAML whitespace changed');
      $('reader').focus(); $('reader').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      check($('header-content').hidden, 'header obstructs frontmatter check');
      $('reader').scrollTop = 0;
      select(); $('floating-comment').click(); $('comment').value = '正文批注'; $('comment-form').requestSubmit();
      window.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange'));
      check(CSS.highlights.get('comments').size === 1, 'body comment failed');
      details.querySelector('summary').focus();`);
    await command('press', 'Enter');
    await evaluate(`await wait(() => $('preview').querySelector('.frontmatter').open);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const marker = $('comment-markers').firstElementChild;
      const rect = [...[...CSS.highlights.get('comments')][0].getClientRects()].findLast(rect => rect.width && rect.height);
      check(!marker.hidden && Math.abs(marker.getBoundingClientRect().top - rect.top) < 4, 'expanded marker misplaced: ' + JSON.stringify({hidden:marker.hidden,marker:marker.getBoundingClientRect().top,quote:rect.top}));
      const node = $('preview').querySelector('.frontmatter code').firstChild;
      const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 5);
      window.getSelection().addRange(range); document.dispatchEvent(new Event('selectionchange'));
      check($('floating-comment').hidden, 'metadata accepted a comment');
      window.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange'));
      $('preview').querySelector('.frontmatter summary').focus();`);
    await command('press', 'Enter');
    await evaluate(`await wait(() => !$('preview').querySelector('.frontmatter').open);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = [...[...CSS.highlights.get('comments')][0].getClientRects()].findLast(rect => rect.width && rect.height);
      check(Math.abs($('comment-markers').firstElementChild.getBoundingClientRect().top - rect.top) < 4, 'collapsed marker misplaced');
      $('preview').querySelector('.frontmatter summary').click();`);
    await command('reload');
    await evaluate(`await wait(() => !$('open').disabled && $('preview').querySelector('.frontmatter'));
      check(!$('preview').querySelector('.frontmatter').open && CSS.highlights.get('comments').size === 1, 'restored properties or anchor incorrect');
      $('preview').querySelector('.frontmatter summary').click();`);
    for (const width of [800, 320, 256, 213]) {
      await command('set', 'viewport', String(width), '700');
      await evaluate(`$('settings-toggle').click(); $('file-search').focus();
        check(document.documentElement.scrollWidth <= innerWidth && $('header').scrollWidth <= innerWidth, 'horizontal overflow');
        const pre = $('preview').querySelector('.frontmatter pre');
        check(pre.scrollWidth > pre.clientWidth && getComputedStyle(pre).overflowX === 'auto', 'YAML long line not locally scrollable');
        $('color-mode').value = 'dark'; $('color-mode').dispatchEvent(new Event('change'));
        check(document.documentElement.dataset.colorMode === 'dark', 'dark theme');
        $('color-mode').value = 'light'; $('color-mode').dispatchEvent(new Event('change'));`);
    }
    await command('set', 'viewport', '320', '700');
    await command('screenshot', join(process.cwd(), '.local/workspace-320.png'));
    await evaluate(`$('reader').focus(); $('reader').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      $('reader').scrollTop = 0; $('preview').querySelector('.frontmatter').open = true;`);
    await command('screenshot', join(process.cwd(), '.local/frontmatter-light-320.png'));
    await evaluate(`$('color-mode').value = 'dark'; $('color-mode').dispatchEvent(new Event('change'));`);
    await command('screenshot', join(process.cwd(), '.local/frontmatter-dark-320.png'));
  } finally {
    await command('close').catch(() => {});
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const client of lists.clients.keys()) lists.release(client);
    await rm(directory, { recursive: true, force: true });
  }
});

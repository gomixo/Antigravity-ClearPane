import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);
const browser = process.env.AGENT_BROWSER_BIN || join(homedir(), 'AppData/Roaming/npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe');
const panel = new URL('../plugin/sidecars/panel/', import.meta.url);
const preload = `
const qa = window.qa = { calls: [], finish: null, mode: 'pending', states: new Map(JSON.parse(sessionStorage.getItem('restore') || '[]')), feedbackTimers: [] };
sessionStorage.removeItem('restore');
const text = '# 测试文章\\n\\n' + Array.from({ length: 60 }, (_, i) => '正文段落 ' + i).join('\\n\\n');
const path = 'D:\\\\example.md';
const documentState = { path, text, name: 'example.md', checkedAt: '2026-10-14T00:00:00Z' };
const initial = id => ({ path, document: documentState, revision: 1, error: null, draft: null,
  comments: Array.from({ length: Number(new URLSearchParams(location.search).get('count') ?? 2) }, (_, i) => ({ path, quote: '正文', revision: 1, conversationId: id, valid: true,
    comment: '意见 ' + i, sourceChanged: false,
    anchor: { start: { path: [2, 0], offset: 0 }, end: { path: [2, 0], offset: 2 } } })),
  sending: false, uncertain: false, commentText: '', instruction: '执行修改', scrollTop: 240 });
const nativeTimeout = window.setTimeout;
const nativeClearTimeout = window.clearTimeout;
window.setTimeout = (handler, delay, ...args) => {
  const id = nativeTimeout(handler, delay === 15000 && qa.mode === 'timeout' ? 50 : delay, ...args);
  if (delay === 4000) qa.feedbackTimers.push({ id, handler, cancelled: false });
  return id;
};
window.clearTimeout = id => {
  const timer = qa.feedbackTimers.find(timer => timer.id === id);
  if (timer) timer.cancelled = true;
  nativeClearTimeout(id);
};
window.sidecar = { conversationId: 'A', fetch: async (url, options) => {
  const body = JSON.parse(options.body);
  let data;
  if (url === '/api/read') data = documentState;
  if (url === '/api/settings/read') data = { fontSize: 16, lineHeight: 1.8, colorMode: 'light' };
  if (url === '/api/session/read') data = qa.states.get(body.conversationId) || { version: 0, state: initial(body.conversationId) };
  if (url === '/api/session/write') {
    const saved = { version: body.version + 1, state: structuredClone(body.state) };
    qa.states.set(body.conversationId, saved);
    data = { version: saved.version };
  }
  return { ok: true, json: async () => structuredClone(data) };
}, agent: { sendMessage: (message, id) => {
  qa.calls.push({ message, id });
  return new Promise(resolve => { qa.finish = resolve; });
} } };
`;

test('comment shortcuts, responsive help and batch send lifecycle', { timeout: 120000 }, async t => {
  try { await access(browser); await access(new URL('assets/app.js', panel)); }
  catch { t.skip('Build assets and install agent-browser to run the browser check'); return; }
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/preload.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(preload);
        return;
      }
      const name = path === '/' ? 'index.html' : path.slice(1);
      if (!/^(index\.html|styles\.css|assets\/[\w.-]+)$/.test(name)) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(await readFile(new URL(name, panel)));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const session = 'clearpane-batch-' + randomUUID();
  const command = async (...args) => (await run(browser, ['--session', session, ...args], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout;
  const evaluate = async code => {
    const output = await command('eval', '-b', Buffer.from(code).toString('base64')).catch(error => { throw new Error(error.stderr || error.message.slice(0, 200)); });
    assert.match(output, /"ok"/);
  };
  const ready = `async function waitFor(check) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('UI wait timed out'); }
    const $ = id => document.getElementById(id);
    function check(value, message) { if (!value) throw new Error(message); }
    function shortcut(target, options = {}) { return target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true, ...options })); }
    function checkCount(count) {
      check($('batch-count')?.textContent === String(count), 'Badge count does not match comments');
      check($('show-batch').getAttribute('aria-label') === '待发送 ' + count + ' 条评论', 'Accessible count did not update');
      check($('show-batch').classList.contains('has-comments') === (count > 0), 'Pending emphasis is incorrect');
    }
    await waitFor(() => !$('show-batch').disabled && !$('preview').hidden);
    checkCount($('batch-list').children.length);`;
  try {
    await command('open', `http://127.0.0.1:${server.address().port}`);
    await evaluate(`(async () => { ${ready}
      $('reader').scrollTop = 0; $('reader').dispatchEvent(new Event('scroll'));
      const paragraph = document.querySelector('#preview p');
      const range = document.createRange(); range.selectNodeContents(paragraph);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      document.dispatchEvent(new Event('selectionchange')); $('floating-comment').click();
      $('comment').value = '未加入的草稿'; $('comment').dispatchEvent(new Event('input'));
      const draftQuote = $('quote').textContent;
      $('comment-markers').children[1].click();
      check(!$('batch-dialog').open && !$('edit-comment-panel').hidden && $('comment-panel').hidden, 'Pencil must open only one comment');
      check(document.activeElement === $('edit-comment') && $('edit-comment').value === '意见 1', 'Pencil did not focus the matching comment');
      check($('edit-comment-quote').textContent === '正文' && $('edit-comment-path').textContent, 'Single editor lost its reference');
      const before = structuredClone(qa.states.get('A').state);
      $('edit-comment').value = '单条即时修改'; $('edit-comment').dispatchEvent(new Event('input'));
      await waitFor(() => qa.states.get('A').state.comments[1].comment === '单条即时修改');
      const saved = qa.states.get('A').state;
      check(JSON.stringify(saved.comments[0]) === JSON.stringify(before.comments[0]) && saved.comments.length === 2, 'Pencil changed another comment or count');
      check(saved.comments[1].quote === before.comments[1].quote && JSON.stringify(saved.comments[1].anchor) === JSON.stringify(before.comments[1].anchor), 'Pencil changed the anchor');
      check(saved.commentText === '未加入的草稿' && $('quote').textContent === draftQuote && saved.instruction === before.instruction, 'Pencil overwrote the draft or instruction');
      shortcut($('edit-comment')); check(!qa.calls.length && !$('edit-comment-panel').hidden, 'Single edit submitted a batch');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      check($('edit-comment-panel').hidden && document.activeElement === $('comment-markers').children[1], 'Escape did not close and return focus');
      $('comment-markers').firstElementChild.click();
      check($('edit-comment').value === '意见 0', 'First pencil opened another comment');
      $('close-edit-comment').click();
      $('comment-markers').children[1].click();
      check($('edit-comment').value === '单条即时修改', 'Reopen lost the edit');
      $('edit-comment').value = ' '; $('edit-comment').dispatchEvent(new Event('input'));
      check($('send-batch').disabled && $('edit-comment').getAttribute('aria-invalid') === 'true', 'Blank edit must block sending');
      $('edit-comment').value = '单条即时修改'; $('edit-comment').dispatchEvent(new Event('input'));
      $('reader').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      check($('edit-comment-panel').hidden, 'Outside click did not close the single editor');
      $('resume-comment').click();
      check(!$('comment-panel').hidden && $('comment').value === '未加入的草稿' && $('quote').textContent === draftQuote, 'Original draft cannot resume');
      $('comment-markers').children[1].click();
      document.documentElement.style.display = 'none';
      await waitFor(() => $('open').disabled);
      check($('edit-comment-panel').hidden, 'Hidden panel retained an active editor');
      document.documentElement.style.display = '';
      await waitFor(() => !$('open').disabled);
      $('comment-markers').children[1].click();
      window.sidecar.conversationId = 'B'; $('edit-comment').value = '不能写入 B'; $('edit-comment').dispatchEvent(new Event('input'));
      await waitFor(() => !$('open').disabled && $('batch-comment-1').value === '意见 1');
      check($('edit-comment-panel').hidden && qa.states.get('A').state.comments[1].comment === '单条即时修改', 'Conversation switch leaked an edit');
      window.sidecar.conversationId = 'A'; $('batch-instruction').dispatchEvent(new Event('input'));
      await waitFor(() => !$('open').disabled && $('batch-comment-1').value === '单条即时修改');
      check(!qa.calls.length, 'Editing called Agent');
      return 'ok'; })()`);
    for (const width of [800, 320, 213]) {
      await command('set', 'viewport', String(width), '700');
      await evaluate(`(async () => { ${ready}
        $('reader').focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        $('comment-markers').children[1].click();
        document.querySelector('#edit-comment-panel details').open = true;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const box = $('edit-comment-panel').getBoundingClientRect();
        check(box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && $('edit-comment-panel').scrollWidth <= $('edit-comment-panel').clientWidth, 'Single editor overflows');
        check(!$('batch-dialog').open && document.activeElement === $('edit-comment'), 'Single editor lost focus');
        return 'ok'; })()`);
      await command('screenshot', resolve('.local', 'single-comment-' + width + '.png'));
    }
    await evaluate(`(async () => { ${ready}
      $('show-batch').click();
      check($('edit-comment-panel').hidden && $('batch-dialog').open && $('batch-list').children.length === 2 && $('batch-comment-1').value === '单条即时修改', 'Header no longer opens the full updated list');
      $('close-batch').click(); $('comment-markers').children[1].click();
      $('clear-batch').click();
      check($('edit-comment-panel').hidden && !$('comment-markers').children.length, 'Removed target kept its editor');
      return 'ok'; })()`);
    await command('reload');
    await evaluate(`(async () => { ${ready}
      $('comment-markers').children[1].click();
      $('edit-comment').value = '页面重建保留'; $('edit-comment').dispatchEvent(new Event('input'));
      await waitFor(() => qa.states.get('A').state.comments[1].comment === '页面重建保留');
      sessionStorage.setItem('restore', JSON.stringify([...qa.states]));
      return 'ok'; })()`);
    await command('reload');
    await evaluate(`(async () => { ${ready}
      check($('edit-comment-panel').hidden && $('batch-comment-1').value === '页面重建保留', 'Recreated page lost the edit');
      $('comment-markers').children[1].click();
      check($('edit-comment').value === '页面重建保留', 'Recreated pencil loaded the wrong comment');
      $('close-edit-comment').click();
      return 'ok'; })()`);
    await command('reload');
    await command('set', 'viewport', '800', '700');
    await evaluate(`(async () => { ${ready}
      check(document.querySelectorAll('#show-batch').length === 1 && $('show-batch').closest('.header-strip'), 'Button must be in the persistent header');
      $('reader').focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      check($('header-content').hidden && $('show-batch').checkVisibility(), 'Collapsed header hides pending button');
      $('show-batch').focus();
      return 'ok'; })()`);
    await command('press', 'Enter');
    await evaluate(`(async () => { ${ready}
      check($('batch-dialog').open, 'Pending button does not support keyboard activation');
      $('clear-batch').click(); checkCount(0);
      check(!$('show-batch').disabled && !$('batch-list').children.length, 'Empty pending list must remain available');
      $('close-batch').click();
      return 'ok'; })()`);
    await command('reload');
    await evaluate(`(async () => { ${ready}
      const paragraph = document.querySelector('#preview p');
      paragraph.scrollIntoView({ block: 'center' });
      const range = document.createRange(); range.selectNodeContents(paragraph);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      document.dispatchEvent(new Event('selectionchange')); $('floating-comment').click();
      check(!$('comment-panel').hidden && $('add-comment').disabled, 'Comment panel did not open with blank comment disabled');
      check(!shortcut($('comment')) && !$('comment-panel').hidden && $('batch-list').children.length === 2, 'Blank shortcut added a comment or inserted a newline');
      $('comment').value = '快捷键意见'; $('comment').dispatchEvent(new Event('input'));
      checkCount(2);
      for (const options of [{ isComposing: true }, { repeat: true }, { ctrlKey: false }]) {
        check(shortcut($('comment'), options), 'Ignored key was prevented');
        check(!$('comment-panel').hidden && $('batch-list').children.length === 2, 'Ignored key added a comment');
      }
      check($('add-comment').textContent === '加入待发送（Ctrl+Enter）' && $('add-comment').getAttribute('aria-keyshortcuts') === 'Control+Enter', 'Add shortcut hint missing');
      $('comment').focus(); $('comment').setSelectionRange(5, 5);
      return 'ok'; })()`);
    await command('press', 'Enter');
    await evaluate(`(() => { const input = document.getElementById('comment'); if (!input.value.includes('\\n') || document.getElementById('comment-panel').hidden) throw new Error('Plain Enter must insert a newline'); return 'ok'; })()`);
    await mkdir(resolve('.local'), { recursive: true });
    for (const [width, theme] of [[800, 'light'], [800, 'dark'], [320, 'light'], [320, 'dark']]) {
      await command('set', 'viewport', String(width), '700');
      await evaluate(`(async () => { ${ready}
        document.documentElement.dataset.colorMode = '${theme}';
        const reference = document.querySelector('.comment-reference'); reference.open = true;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const title = reference.querySelector('.comment-reference-title').getBoundingClientRect();
        const help = $('comment-help').getBoundingClientRect();
        const quote = $('quote').getBoundingClientRect();
        check($('comment-help').textContent === '加入后不会运行 Agent。按 Esc 收起并保留草稿。', 'Help text changed');
        check(${width} === 320 ? help.top >= title.bottom : Math.abs(help.top - title.top) < 4, 'Help did not align or wrap');
        check(quote.top >= Math.max(title.bottom, help.bottom) && quote.width >= reference.clientWidth - 2, 'Expanded reference does not span the row');
        check($('comment-panel').scrollWidth <= $('comment-panel').clientWidth && $('add-comment').getBoundingClientRect().right <= innerWidth, 'Comment panel overflows');
        return 'ok'; })()`);
      await command('screenshot', resolve('.local', 'comment-shortcuts-' + width + '-' + theme + '.png'));
      await evaluate(`(async () => { ${ready}
        $('show-batch').click(); $('batch-list').firstElementChild.open = true;
        check($('batch-dialog').scrollWidth <= $('batch-dialog').clientWidth && $('send-batch').getBoundingClientRect().right <= innerWidth, 'Batch dialog overflows');
        return 'ok'; })()`);
      await command('screenshot', resolve('.local', 'batch-shortcuts-' + width + '-' + theme + '.png'));
      await evaluate(`(() => { document.getElementById('close-batch').click(); document.getElementById('resume-comment').click(); return 'ok'; })()`);
    }
    await command('set', 'viewport', '800', '700');
    await command('press', 'Control+Enter');
    await evaluate(`(async () => { ${ready}
      check($('comment-panel').hidden && $('batch-list').children.length === 3 && !qa.calls.length, 'Shortcut must add once without calling Agent');
      checkCount(3);
      shortcut($('comment')); check($('batch-list').children.length === 3, 'Hidden comment form added again');
      return 'ok'; })()`);
    await command('reload');
    await evaluate(`(async () => { ${ready}
      $('show-batch').click();
      check(!$('batch-path'), 'File path was not removed');
      check(!$('batch-dialog').textContent.includes('统一发送才会触发 Agent'), 'Footer was not removed');
      check([...$('batch-list').children].every(row => !row.open), 'Editors must start collapsed');
      check(!$('batch-comment-0').checkVisibility(), 'Collapsed editor is visible');
      $('batch-list').firstElementChild.querySelector('summary').focus();
      return 'ok'; })()`);
    await command('press', 'Enter');
    await evaluate(`(() => { if (!document.querySelector('.batch-item').open || !document.getElementById('batch-comment-0').checkVisibility()) throw new Error('Keyboard expansion failed'); return 'ok'; })()`);
    await command('focus', '#batch-instruction');
    await command('press', 'Enter');
    await evaluate(`(() => { const input = document.getElementById('batch-instruction'); if (!input.value.includes('\\n') || !document.getElementById('batch-dialog').open || qa.calls.length) throw new Error('Plain Enter must only insert a newline'); input.value = '执行修改'; input.dispatchEvent(new Event('input')); return 'ok'; })()`);
    await evaluate(`(async () => { ${ready}
      const input = $('batch-comment-0');
      check(!input.closest('.batch-item').querySelector('details').open, 'Reference must remain collapsed');
      input.value = '修改后的意见'; input.dispatchEvent(new Event('input', { bubbles: true }));
      check(document.querySelector('.item-count').textContent === '6 / 4000', 'Count did not update');
      input.value = ' '; input.dispatchEvent(new Event('input', { bubbles: true }));
      check($('send-batch').disabled, 'Blank comment must block sending');
      check(!shortcut(input) && $('batch-dialog').open && !qa.calls.length, 'Disabled batch shortcut sent or inserted a newline');
      $('batch-form').requestSubmit();
      check($('batch-dialog').open && !qa.calls.length, 'Invalid submission closed the dialog or sent');
      input.value = '修改后的意见'; input.dispatchEvent(new Event('input', { bubbles: true }));
      $('batch-list').children[1].querySelector('summary').click();
      $('batch-list').children[1].querySelector('button').click();
      check($('batch-list').children.length === 1, 'Delete failed');
      checkCount(1);
      $('close-batch').click(); $('show-batch').click();
      check(!document.querySelector('.batch-item').open, 'Reopening must collapse all comments');
      $('close-batch').click();
      const top = $('reader').scrollTop;
      $('comment-markers').firstElementChild.click();
      check(!$('batch-dialog').open && !$('edit-comment-panel').hidden && document.activeElement === $('edit-comment'), 'Pencil did not open the single editor');
      $('close-edit-comment').click(); $('show-batch').click(); $('batch-list').firstElementChild.open = true;
      for (const target of [$('batch-comment-0'), $('batch-instruction')]) {
        for (const options of [{ isComposing: true }, { repeat: true }, { ctrlKey: false }]) {
          check(shortcut(target, options) && $('batch-dialog').open && !qa.calls.length, 'Ignored key sent the batch');
        }
      }
      check($('send-batch').textContent === '统一发送（Ctrl+Enter）' && $('send-batch').getAttribute('aria-keyshortcuts') === 'Control+Enter', 'Send shortcut hint missing');
      shortcut($('batch-comment-0'));
      check(!$('batch-dialog').open, 'Dialog must close before the send settles');
      check(document.activeElement === $('reader') && $('reader').scrollTop === top, 'Reading focus or position changed');
      check($('batch-status').checkVisibility() && $('batch-status').textContent.includes('正在'), 'Sending status is not visible');
      $('batch-form').requestSubmit();
      shortcut($('batch-comment-0')); shortcut($('batch-instruction'), { repeat: true });
      await waitFor(() => qa.calls.length === 1);
      check(qa.calls[0].message.includes('文件：') && qa.calls[0].message.includes('修改后的意见'), 'Payload lost file or edited comment');
      qa.finish({});
      await waitFor(() => $('batch-count').textContent === '0');
      check(qa.calls.length === 1 && $('batch-instruction').value === '' && !$('comment-markers').children.length, 'Success did not clear the batch or sent twice');
      checkCount(0);
      const success = $('batch-status').textContent;
      check(success.includes('评论已统一发送') && qa.feedbackTimers.length === 1, 'Success did not start a four-second timer');
      await new Promise(r => setTimeout(r, 4100));
      check($('batch-status').hidden && !$('status').textContent.includes(success) && !$('batch-warning').textContent.includes(success), 'Success notice did not expire everywhere');
      const addDraft = () => {
        const paragraph = document.querySelector('#preview p');
        const range = document.createRange(); range.selectNodeContents(paragraph);
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
        document.dispatchEvent(new Event('selectionchange')); $('floating-comment').click();
        $('comment').value = '下一条意见'; $('comment').dispatchEvent(new Event('input')); $('comment-form').requestSubmit();
      };
      addDraft(); $('show-batch').click(); $('send-batch').click();
      await waitFor(() => qa.calls.length === 2); qa.finish({});
      await waitFor(() => qa.feedbackTimers.length === 2);
      const previous = qa.feedbackTimers[1];
      addDraft(); $('show-batch').click(); $('send-batch').click();
      await waitFor(() => qa.calls.length === 3);
      check(previous.cancelled, 'New send did not cancel the old success timer');
      await new Promise(r => setTimeout(r, 4100));
      check($('batch-status').textContent.includes('正在') && !$('batch-status').hidden, 'Old timer cleared the new sending state');
      qa.finish({ response: { error: 'rejected' } });
      await waitFor(() => $('batch-status').classList.contains('error'));
      const failure = $('batch-status').textContent;
      await new Promise(r => setTimeout(r, 4100));
      check($('batch-status').textContent === failure && !$('batch-status').hidden, 'Failure notice expired');
      return 'ok'; })()`);
    for (const outcome of ['rejected', 'timeout']) {
      await command('reload');
      await evaluate(`(async () => { ${ready}
        qa.mode = '${outcome}'; $('show-batch').click(); qa.readingTop = $('reader').scrollTop;
        $('batch-instruction').focus();
        return 'ok'; })()`);
      await command('press', 'Control+Enter');
      await evaluate(`(async () => { ${ready}
        check(!$('batch-dialog').open && $('reader').scrollTop === qa.readingTop, 'Return must be immediate');
        await waitFor(() => qa.calls.length === 1);
        ${outcome === 'rejected' ? "qa.finish({ response: { error: 'rejected' } });" : ''}
        await waitFor(() => $('batch-status').classList.contains('error'));
        check($('batch-list').children.length === 2 && $('batch-instruction').value === '执行修改', 'Failure lost the batch');
        checkCount(2);
        $('settings-toggle').click(); $('show-batch').click();
        check(${outcome === 'timeout' ? "!$('unlock-batch').hidden && $('send-batch').disabled" : "$('unlock-batch').hidden && !$('send-batch').disabled"}, 'Retry lock is incorrect');
        if (qa.mode === 'timeout') {
          shortcut($('batch-instruction')); check(qa.calls.length === 1 && $('batch-dialog').open, 'Uncertain shortcut retried the send');
          qa.finish({}); check($('send-batch').disabled, 'Late receipt unlocked retry');
        }
        return 'ok'; })()`);
    }
    await command('reload');
    await evaluate(`(async () => { ${ready}
      $('show-batch').click(); $('send-batch').click();
      await waitFor(() => qa.calls.length === 1);
      window.sidecar.conversationId = 'B'; $('batch-instruction').dispatchEvent(new Event('input'));
      await waitFor(() => qa.states.has('A') && !$('show-batch').disabled && $('batch-list').children.length === 2);
      $('batch-instruction').value = 'B 的指令'; $('batch-instruction').dispatchEvent(new Event('input'));
      const b = structuredClone(qa.states.get('B'));
      qa.finish({});
      await waitFor(() => qa.states.get('A').state.comments.length === 0);
      check($('batch-list').children.length === 2 && $('batch-instruction').value === 'B 的指令', 'Send completion changed another conversation');
      checkCount(2);
      check(JSON.stringify(qa.states.get('B')) === JSON.stringify(b), 'Send completion overwrote the other cache');
      window.sidecar.conversationId = 'A'; $('batch-instruction').dispatchEvent(new Event('input'));
      await waitFor(() => $('batch-list').children.length === 0);
      check($('batch-instruction').value === '' && qa.calls.length === 1, 'Original conversation did not retain success');
      checkCount(0);
      return 'ok'; })()`);
    await command('open', `http://127.0.0.1:${server.address().port}/?count=123`);
    for (const width of [800, 320, 256, 213]) {
      await command('set', 'viewport', String(width), '700');
      for (const theme of ['light', 'dark']) {
        await evaluate(`(async () => { ${ready}
          document.documentElement.dataset.colorMode = '${theme}';
          $('reader').focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          checkCount(123);
          const pending = $('show-batch').getBoundingClientRect();
          const settings = $('settings-toggle').getBoundingClientRect();
          const badge = $('batch-count');
          check($('header-content').hidden && $('show-batch').checkVisibility(), 'Collapsed pending button disappeared');
          check(document.documentElement.scrollWidth <= innerWidth && pending.left >= 0 && settings.right <= innerWidth, 'Header overflows');
          check(pending.right <= settings.left && document.querySelector('.header-strip').getBoundingClientRect().height === 42, 'Header buttons overlap or height changed');
          check(badge.scrollWidth <= badge.clientWidth && badge.textContent === '123', 'Badge clipped or abbreviated');
          return 'ok'; })()`);
        await command('screenshot', resolve('.local', 'pending-header-' + width + '-' + theme + '.png'));
      }
    }
  } finally {
    await command('close').catch(() => {});
    await new Promise(resolve => server.close(resolve));
  }
});

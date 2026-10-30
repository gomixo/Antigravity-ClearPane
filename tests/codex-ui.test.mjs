import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { createReaderService } from '../codex/service.mjs';

const browser = process.env.AGENT_BROWSER_BIN || join(homedir(), 'AppData/Roaming/npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe');
test('Codex browser review and MCP Apps protocol: rendering, drafts, copy and one batch message', { timeout: 120000 }, async t => {
  try { await access(browser); await access(resolve('codex/web/assets/app.js')); }
  catch { t.skip('Run npm run build:codex and install agent-browser'); return; }
  const temporary = await mkdtemp(join(tmpdir(), 'clearpane-codex-ui-'));
  const path = join(temporary, '文章.md');
  const source = '# Codex 阅读测试\n\n第一段需要修改，保留引用与路径。\n\n第二段也需要评审。\n\n公式 $x^2 + y^2$\n\n```mermaid\nflowchart LR\n A[阅读] --> B[批注]\n```\n\n![本地图片](image.png)\n\n' +
    Array.from({ length: 35 }, (_, i) => `阅读段落 ${i}，用于检查滚动与更新。`).join('\n\n');
  await writeFile(path, source);
  await writeFile(join(temporary, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const service = createReaderService({ settingsDirectory: join(temporary, 'settings') });
  await service.listen();
  const config = await service.openReader({ workspaceRoots: [temporary], path, targetLabel: '浏览器评审' });
  const appConfig = await service.openReader({ workspaceRoots: [temporary], path, targetLabel: 'MCP 协议测试宿主' });
  const hostSource = `import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
    const qa = window.qa = { mode: 'rejected', calls: [] };
    const frame = document.getElementById('app');
    const bridge = new AppBridge(null, { name: 'test-host', version: '1.0.0' },
      { serverTools: {}, message: { text: {} } }, { hostContext: { theme: 'dark' } });
    qa.bridge = bridge;
    bridge.oncalltool = async params => {
      const response = await fetch('/rpc', { method: 'POST', body: JSON.stringify(params.arguments) });
      return response.json();
    };
    bridge.onmessage = async params => {
      qa.calls.push(params);
      if (qa.mode === 'pending') return new Promise(resolve => { qa.finish = resolve; });
      if (qa.mode === 'timeout') return new Promise(() => {});
      return { isError: qa.mode === 'rejected' };
    };
    bridge.oninitialized = () => bridge.sendToolResult({ content: [], _meta: { clearpane: ${JSON.stringify(appConfig)} } });
    await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
    frame.src = '/ui';`;
  const hostBundle = await build({ stdin: { contents: hostSource, resolveDir: resolve('.') }, bundle: true,
    write: false, format: 'esm', platform: 'browser' });
  const frameHtml = (await readFile(resolve('codex/web/mcp.html'), 'utf8')).replace('<body>', `<body><script>
    const nativeTimer = window.setTimeout;
    window.setTimeout = (handler, delay, ...args) => nativeTimer(handler, delay === 12000 && window.parent.qa.mode === 'timeout' ? 80 : delay, ...args);
    </script>`);
  const host = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/host.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(hostBundle.outputFiles[0].text); }
      else if (url.pathname === '/ui') {
        response.setHeader('Content-Type', 'text/html');
        response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src blob: data:;");
        response.end(frameHtml);
      } else if (url.pathname === '/rpc') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const args = JSON.parse(Buffer.concat(chunks));
        try { response.end(JSON.stringify({ content: [], structuredContent: await service.api(args.session, args.token, args.endpoint, args.body) })); }
        catch (error) { response.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: error.message }] })); }
      } else response.end('<!doctype html><title>MCP Apps test host</title><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe id="app" title="ClearPane"></iframe><script type="module" src="/host.js"></script>');
    } catch (error) { response.writeHead(500).end(error.message); }
  });
  await new Promise(resolveListen => host.listen(0, '127.0.0.1', resolveListen));
  const run = promisify(execFile);
  const session = 'clearpane-codex-' + randomUUID();
  const command = async (...args) => (await run(browser, ['--session', session, ...args], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout;
  t.after(async () => {
    await command('close').catch(() => {}); await service.close(); host.closeAllConnections();
    await new Promise(resolveClose => host.close(resolveClose));
    await rm(temporary, { recursive: true, force: true });
  });
  const evaluate = async code => {
    const output = await command('eval', '-b', Buffer.from(`(async () => { ${code}; return 'ok'; })()`).toString('base64'));
    assert.match(output, /"ok"/);
  };
  const helpers = `const check = (value, message) => { if (!value) throw Error(message); };
    async function waitFor(checker) { for (let i = 0; i < 400; i++) { if (checker()) return; await new Promise(r => setTimeout(r, 20)); } throw Error('UI wait timed out'); }
    const doc = ${'FRAME'}, $ = id => doc.getElementById(id);
    function comment(text, index = 0) {
      const range = doc.createRange(); range.selectNodeContents(doc.querySelectorAll('#preview p')[index]);
      const selected = doc.defaultView.getSelection(); selected.removeAllRanges(); selected.addRange(range);
      doc.dispatchEvent(new Event('selectionchange')); $('select-comment').click();
      $('comment').value = text; $('comment').dispatchEvent(new Event('input')); $('comment-form').requestSubmit();
    }
    await waitFor(() => !$('preview').hidden && !$('show-batch').disabled);`;
  const local = helpers.replace('FRAME', 'document');
  const embedded = helpers.replace('FRAME', "document.getElementById('app').contentDocument");
  await command('open', config.url);
  await evaluate(`${local}
    check(!location.hash, 'Credential fragment was not removed');
    await waitFor(() => doc.querySelector('.katex') && doc.querySelector('.diagram svg') && doc.querySelector('#preview img')?.naturalWidth);
    check($('send-batch').hidden && $('send-batch').disabled, 'Browser must offer copy only');
    check($('host-target').textContent === '浏览器评审', 'Missing target label');
    comment('修改第一段'); comment('修改第二段', 1);
    $('show-batch').click();
    $('batch-instruction').value = '一起修改'; $('batch-instruction').dispatchEvent(new Event('input'));
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw Error('permission denied'); } });
    $('copy-batch').click(); await waitFor(() => $('export-dialog').open);
    check($('export-text').value.includes('批量评论（2 条）') && $('export-text').value.includes('修改第一段') && $('export-text').value.includes('一起修改') && $('export-text').value.includes('文章.md'), 'Copy fallback lost review context');
    check($('batch-count').textContent === '2', 'Copy cleared comments');
    $('close-export').click(); $('close-batch').click();`);
  await command('reload');
  await evaluate(`${local}
    check($('batch-count').textContent === '2' && $('batch-instruction').value === '一起修改', 'Reload lost drafts');
    $('settings-toggle').click(); $('color-mode').value = 'dark'; $('color-mode').dispatchEvent(new Event('change'));
    check(doc.documentElement.dataset.colorMode === 'dark', 'Theme not applied');
    doc.defaultView.getSelection().removeAllRanges(); doc.dispatchEvent(new Event('selectionchange'));`);
  await writeFile(path, source + '\n\n外部更新内容。');
  await evaluate(`${local}
    await waitFor(() => $('preview').textContent.includes('外部更新内容'));
    check($('batch-count').textContent === '2', 'Update lost review comments');`);
  for (const width of [375, 320]) {
    await command('set', 'viewport', String(width), '740');
    await evaluate(`${local} $('show-batch').click();
      await new Promise(r => requestAnimationFrame(r));
      const box = $('batch-dialog').getBoundingClientRect();
      check(box.left >= 0 && box.right <= innerWidth + 1 && $('batch-dialog').scrollWidth <= $('batch-dialog').clientWidth, 'Batch overflows narrow screen');
      $('close-batch').click();`);
  }
  await command('set', 'viewport', '1024', '900');
  await command('open', `http://127.0.0.1:${host.address().port}`);
  await evaluate(`${embedded}
    await waitFor(() => doc.defaultView.clearpane?.canSend);
    check($('batch-count').textContent === '0', 'Sessions leaked comments');
    await waitFor(() => doc.querySelector('.diagram svg') && doc.querySelector('#preview img')?.naturalWidth);
    comment('MCP 第一条'); comment('MCP 第二条', 1);
    check(!qa.calls.length, 'Adding comments sent a message');
    $('show-batch').click(); check(!$('send-batch').hidden, 'Host message action missing');
    $('batch-form').requestSubmit();
    await waitFor(() => qa.calls.length === 1 && !$('send-batch').disabled);
    check($('batch-count').textContent === '2', 'Rejected send lost comments');
    check(qa.calls[0].role === 'user' && qa.calls[0].content[0].text.includes('MCP 第二条'), 'Not one complete batch');
    qa.mode = 'timeout'; $('batch-form').requestSubmit();
    await waitFor(() => !$('unlock-batch').hidden);
    check(qa.calls.length === 2 && $('send-batch').disabled && $('batch-count').textContent === '2', 'Unknown send must retain and lock');
    $('unlock-batch').click(); qa.mode = 'pending'; $('batch-form').requestSubmit();
    await waitFor(() => !!qa.finish); check(qa.calls.length === 3 && $('send-batch').disabled, 'Duplicate send possible');
    qa.finish({}); await waitFor(() => $('batch-count').textContent === '0');
    check(qa.calls.length === 3, 'Send retried automatically');
    $('close-batch').click(); $('settings-toggle').click(); $('color-mode').value = 'system'; $('color-mode').dispatchEvent(new Event('change'));
    qa.bridge.setHostContext({ theme: 'light' });
    await waitFor(() => doc.documentElement.dataset.colorMode === 'light');`);
  await mkdir(resolve('.local'), { recursive: true });
  await command('screenshot', resolve('.local/codex-reader.png'));
  await evaluate(`${embedded}
    await qa.bridge.sendToolResult({ content: [], _meta: { clearpane: { session: 'another-reader' } } });
    await waitFor(() => !$('status').textContent.includes('已检查') && $('open').disabled);
    check(!doc.defaultView.clearpane.canSend && doc.defaultView.clearpane.conversationId === null, 'Reused iframe can send old drafts');
    const result = await doc.defaultView.clearpane.agent.sendMessage('must not send', 'another-reader');
    check(result.error && qa.calls.length === 3, 'Reused iframe sent a stale message');`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);
const browser = process.env.AGENT_BROWSER_BIN || join(homedir(), 'AppData/Roaming/npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe');
const loader = join(homedir(), '.gemini/config/node_modules/sidecar_sdk/register_loader.js');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><rect width="1200" height="600" fill="#34765d"/><text x="60" y="300" font-size="100" fill="white">ClearPane image</text></svg>';

test('real SDK displays local and network images, preserves comments and cleans up stale loads', { timeout: 120000 }, async t => {
  try { await access(browser); await access(loader); await access(new URL('../plugin/sidecars/panel/assets/app.js', import.meta.url)); }
  catch { t.skip('Installed SDK, browser and build required'); return; }
  const openssl = process.env.OPENSSL_BIN || (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
  try { await run(openssl, ['version'], { windowsHide: true }); }
  catch { t.skip('OpenSSL required for the local HTTPS image fixture'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'clearpane-image-ui-'));
  await run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'),
    '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { windowsHide: true });
  const networkRequests = [];
  const remote = createServer((request, response) => {
    networkRequests.push({ url: request.url, referer: request.headers.referer, token: request.headers['x-sidecar-token'] });
    if (request.url.startsWith('/missing')) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }).end(svg);
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const secureRemote = createHttpsServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, (request, response) => {
    networkRequests.push({ url: request.url, referer: request.headers.referer, token: request.headers['x-sidecar-token'] });
    response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }).end(svg);
  });
  await new Promise(resolve => secureRemote.listen(0, '127.0.0.1', resolve));
  const networkUrl = `http://127.0.0.1:${remote.address().port}/image.svg?size=large&name=中文`;
  const file = join(directory, '文章.md');
  const other = join(directory, '另一篇.md');
  const image = join(directory, '中文 空格.svg');
  await mkdir(join(directory, 'nested'));
  await writeFile(image, svg);
  await writeFile(other, '# 另一篇文章\n\n没有图片');
  const article = '# 图片文章\n\n可选评论正文\n\n' + [
    ['relative', './' + encodeURIComponent('中文 空格.svg')], ['parent', './nested/../' + encodeURIComponent('中文 空格.svg')],
    ['absolute', image.replaceAll('\\', '/')], ['file-uri', pathToFileURL(image).href],
    ['network', networkUrl], ['https', `https://127.0.0.1:${secureRemote.address().port}/image.svg?q=1`],
    ['missing-local', './missing.png'], ['missing-network', `http://127.0.0.1:${remote.address().port}/missing.png`],
    ['broken', './broken.png'],
  ].map(([alt, src]) => `![${alt}](<${src}>)`).join('\n\n') + '\n\n' + '结尾正文\n\n'.repeat(70);
  await writeFile(join(directory, 'broken.png'), 'invalid image data');
  await writeFile(file, article);
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const token = randomUUID();
  const child = spawn(process.execPath, ['--import', pathToFileURL(loader).href, fileURLToPath(new URL('../plugin/sidecars/panel/main.mjs', import.meta.url))], {
    windowsHide: true, env: { ...process.env, ANTIGRAVITY_SIDECAR_WEB_PORT: String(port), ANTIGRAVITY_SIDECAR_UI_TOKEN: token,
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: directory, ANTIGRAVITY_LS_ADDRESS: 'isolated-image-ui-test', ANTIGRAVITY_CSRF_TOKEN: randomUUID() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stderr.on('data', data => { diagnostics += String(data); });
  const session = 'clearpane-images-' + randomUUID();
  const command = async (...args) => (await run(browser, ['--session', session, '--ignore-https-errors', ...args], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout;
  const evaluate = async code => {
    try {
      const output = await command('eval', '-b', Buffer.from(`(async () => {
        const $ = id => document.getElementById(id);
        const check = (value, message) => { if (!value) throw new Error(message); };
        const wait = async check => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('UI wait timed out'); };
        const open = path => { $('path').value = path; $('open-form').requestSubmit(); };
        ${code}
        return 'ok'; })()`).toString('base64'));
      assert.match(output, /"ok"/);
    } catch (error) {
      const state = await command('eval', 'JSON.stringify({status:document.getElementById("status")?.textContent,images:[...document.querySelectorAll(".document-image img")].map(img=>({alt:img.alt,hidden:img.hidden,width:img.naturalWidth,status:img.nextElementSibling.textContent}))})').catch(() => '');
      throw new Error((error.stderr || error.message).replace(/token=[^&\s"<>]+/g, 'token=<redacted>') + state);
    }
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SDK start timed out: ' + diagnostics)), 6000);
      child.stdout.on('data', data => { if (String(data).includes('listening')) { clearTimeout(timer); resolve(); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('SDK exited: ' + diagnostics)); });
    });
    await command('open', `http://127.0.0.1:${port}/?token=${token}&conversationId=A`);
    await evaluate(`await wait(() => !$('open').disabled);
      window.qa = { created: [], revoked: [], imageReads: 0 };
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = blob => { const url = create(blob); qa.created.push(url); return url; };
      URL.revokeObjectURL = url => { qa.revoked.push(url); revoke(url); };
      const fetch = sidecar.fetch.bind(sidecar);
      sidecar.fetch = (url, options) => { if (url === '/api/images/read') qa.imageReads++; return fetch(url, options); };
      open(${JSON.stringify(file)});
      await wait(() => document.querySelectorAll('.document-image img:not([hidden])').length === 6);
      await wait(() => [...document.querySelectorAll('.image-placeholder')].filter(n => !n.hidden && /失败|不存在/.test(n.textContent)).length === 3);
      check(document.querySelector('img[alt="network"]').naturalWidth === 1200, 'network image');
      check(document.querySelector('img[alt="https"]').naturalWidth === 1200, 'HTTPS image');
      check(document.querySelector('img[alt="file-uri"]').src.startsWith('blob:'), 'local not blob');
      check(document.querySelector('img[alt="network"]').referrerPolicy === 'no-referrer', 'referrer policy');
      window.originalReads = qa.imageReads;
      await wait(() => $('status').textContent.includes('已检查'));
      const node = $('preview').querySelector('p').firstChild;
      const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 2);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      document.dispatchEvent(new Event('selectionchange')); $('floating-comment').click();
      $('comment').value = '图片旁评论'; $('comment-form').requestSubmit();
      check($('batch-count').textContent === '1' && CSS.highlights.get('comments').size === 1, 'comment anchor');
      window.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange'));
      window.beforePreview = $('preview').firstChild;`);
    assert.ok(networkRequests.some(request => request.url.startsWith('/image.svg?size=large&name=')));
    assert.ok(networkRequests.every(request => !request.referer && !request.token));
    await evaluate(`$('reader').scrollTop = 240; window.beforeTop = $('reader').scrollTop;
      await new Promise(r => setTimeout(r, 2200));
      check(qa.imageReads === originalReads && $('preview').firstChild === beforePreview, 'polling reloaded images');
      $('refresh').click();
      await wait(() => qa.imageReads > originalReads && !$('refresh').disabled && document.querySelectorAll('.document-image img:not([hidden])').length === 6);
      check(CSS.highlights.get('comments').size === 1 && $('batch-count').textContent === '1', 'refresh lost comment');
      check(Math.abs($('reader').scrollTop - beforeTop) < 4, 'refresh lost scroll');
      $('show-batch').click(); $('clear-batch').click(); $('close-batch').click();`);
    for (const width of [800, 320, 213]) {
      await command('set', 'viewport', String(width), '700');
      await evaluate(`check(document.documentElement.scrollWidth <= innerWidth, 'horizontal overflow');
        check([...document.querySelectorAll('.document-image img:not([hidden])')].every(img => img.getBoundingClientRect().width <= $('preview').clientWidth), 'image overflow');`);
    }
    await evaluate(`$('reader').scrollTop = 0;`);
    await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
    await command('screenshot', join(process.cwd(), '.local/images-213.png'));
    await evaluate(`window.currentUrls = [...qa.created]; open(${JSON.stringify(other)});
      await wait(() => $('preview').textContent.includes('另一篇文章'));
      check(currentUrls.every(url => qa.revoked.includes(url)), 'blob URLs leaked');
      check(!document.querySelector('.document-image'), 'old images remain');
      open(${JSON.stringify(file)});
      await wait(() => document.querySelectorAll('.document-image img:not([hidden])').length === 6);
      const nativeFetch = sidecar.fetch;
      sidecar.fetch = async (url, options) => {
        if (url !== '/api/images/read') return nativeFetch(url, options);
        qa.signal = options.signal;
        return new Promise(resolve => { qa.finish = () => resolve(new Response(${JSON.stringify(svg)}, { headers: { 'Content-Type': 'image/svg+xml' } })); });
      };
      $('refresh').click(); await wait(() => qa.finish);
      open(${JSON.stringify(other)}); await wait(() => $('preview').textContent.includes('另一篇文章'));
      check(qa.signal.aborted, 'old image request not aborted');
      const created = qa.created.length; qa.finish(); await new Promise(r => setTimeout(r, 50));
      check(qa.created.length === created && !document.querySelector('.document-image'), 'late image entered new article');
      sidecar.fetch = nativeFetch;
      open(${JSON.stringify(file)}); await wait(() => document.querySelectorAll('.document-image img:not([hidden])').length === 6);
      sidecar.conversationId = 'B'; document.dispatchEvent(new Event('selectionchange'));
      await wait(() => !$('open').disabled && $('preview').hidden);
      sidecar.conversationId = 'A'; document.dispatchEvent(new Event('selectionchange'));
      await wait(() => document.querySelectorAll('.document-image img:not([hidden])').length === 6);
      const cache = await (await sidecar.fetch('/api/session/read', { method: 'POST', body: JSON.stringify({ conversationId: 'A' }) })).json();
      check(!JSON.stringify(cache).includes('blob:'), 'image bytes or blob cached');`);
    await command('reload');
    await evaluate(`await wait(() => document.querySelectorAll('.document-image img:not([hidden])').length === 6);
      check($('preview').textContent.includes('可选评论正文'), 'recreated page lost article');`);
    await writeFile(file, article + '\n\n![updated](<' + pathToFileURL(image).href + '>)');
    await evaluate(`await wait(() => document.querySelector('img[alt="updated"]')?.naturalWidth === 1200);
      check(document.querySelectorAll('.document-image img:not([hidden])').length === 7, 'automatic update lost images');`);
  } finally {
    await command('close').catch(() => {});
    remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve));
    secureRemote.closeAllConnections(); await new Promise(resolve => secureRemote.close(resolve));
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    await rm(directory, { recursive: true, force: true });
  }
});

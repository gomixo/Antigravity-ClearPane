import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('real installed SDK authenticates every data API and serves offline assets', async t => {
  const loader = join(homedir(), '.gemini/config/node_modules/sidecar_sdk/register_loader.js');
  try { await access(loader); } catch { t.skip('Installed Antigravity SDK not available'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'clearpane-api-'));
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const token = randomUUID();
  const child = spawn(process.execPath, ['--import', pathToFileURL(loader).href, fileURLToPath(new URL('../plugin/sidecars/panel/main.mjs', import.meta.url))], {
    windowsHide: true, env: { ...process.env, ANTIGRAVITY_SIDECAR_WEB_PORT: String(port), ANTIGRAVITY_SIDECAR_UI_TOKEN: token,
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: directory, ANTIGRAVITY_LS_ADDRESS: 'isolated-acceptance-test', ANTIGRAVITY_CSRF_TOKEN: randomUUID() }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stderr.on('data', data => { diagnostics += String(data); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SDK server did not start')), 6000);
      child.stdout.on('data', data => { if (String(data).includes('listening')) { clearTimeout(timer); resolve(); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('SDK process exited before ready: ' + diagnostics)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const post = (path, data) => fetch(base + path, { method: 'POST', headers: { 'X-Sidecar-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    for (const path of ['/api/read', '/api/images/read', '/api/files/list', '/api/settings/read', '/api/settings/write', '/api/session/read', '/api/session/write']) {
      assert.equal((await fetch(base + path)).status, 405);
      assert.equal((await fetch(base + path, { method: 'POST', body: '{}' })).status, 401);
    }
    const file = join(directory, '中文 测试.md');
    await writeFile(file, 'content A');
    assert.equal((await (await post('/api/read', { path: file })).json()).text, 'content A');
    await writeFile(file, 'content B');
    assert.equal((await (await post('/api/read', { path: file })).json()).text, 'content B');
    const image = Buffer.from('image fixture');
    await writeFile(join(directory, '图片.png'), image);
    const imageResponse = await post('/api/images/read', { documentPath: file, src: './图片.png' });
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get('content-type'), 'image/png');
    assert.equal(imageResponse.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), image);
    assert.equal((await post('/api/images/read', { documentPath: file, src: 'http://example.com/a.png' })).status, 400);
    await post('/api/settings/write', { fontSize: 18, lineHeight: 2 });
    assert.deepEqual(await (await post('/api/settings/read', {})).json(), { fontSize: 18, lineHeight: 2, colorMode: 'system' });
    await post('/api/settings/write', { fontSize: 18, lineHeight: 2, colorMode: 'dark' });
    assert.deepEqual(await (await post('/api/settings/read', {})).json(), { fontSize: 18, lineHeight: 2, colorMode: 'dark' });
    assert.equal((await post('/api/settings/write', { fontSize: 18, lineHeight: 2, colorMode: 'invalid' })).status, 400);
    const page = await fetch(base + '/');
    assert.match(page.headers.get('content-security-policy'), /img-src blob: http: https:;/);
    assert.doesNotMatch(page.headers.get('content-security-policy'), /img-src[^;]*(?:data:|file:)/);
    assert.match(await page.text(), /assets\/app\.js/);
    const script = await fetch(base + '/assets/app.js');
    assert.equal(script.status, 200);
    assert.doesNotMatch(await script.text(), /ClearPane M1 接入验证/);
    assert.equal((await fetch(base + '/assets/app.css')).status, 200);
    assert.equal((await fetch(base + '/settings.json')).status, 404);
    assert.equal((await fetch(base + '/app.js')).status, 404);
    const state = { path: '', document: null, revision: 0, error: null, draft: null,
      comments: [], sending: false, uncertain: false, commentText: '', instruction: '', scrollTop: 0 };
    assert.deepEqual(await (await post('/api/session/read', { conversationId: 'A' })).json(), { version: 0, state: null });
    assert.equal((await post('/api/session/write', { conversationId: 'A', version: 0, state })).status, 200);
    assert.deepEqual(await (await post('/api/session/read', { conversationId: 'A' })).json(), { version: 1, state });
    assert.deepEqual(await (await post('/api/session/read', { conversationId: 'B' })).json(), { version: 0, state: null });
    assert.equal((await post('/api/session/write', { conversationId: 'A', version: 0, state })).status, 409);
    assert.equal((await post('/api/session/write', { conversationId: 'A', version: 1, state: {} })).status, 400);
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    await rm(directory, { recursive: true, force: true });
  }
});

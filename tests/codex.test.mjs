import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createReaderService } from '../codex/service.mjs';
import { PreviewSession } from '../src/session.mjs';

test('Codex reader enforces credentials, canonical grants, isolated drafts and expiry', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'clearpane-codex-'));
  let now = Date.now();
  const service = createReaderService({ settingsDirectory: join(temporary, 'settings'), now: () => now });
  t.after(async () => { await service.close(); await rm(temporary, { recursive: true, force: true }); });
  const root = join(temporary, 'project');
  const outside = join(temporary, 'outside');
  await mkdir(root); await mkdir(outside);
  const path = join(root, '中文 空格.md');
  const external = join(outside, 'external.md');
  await writeFile(path, '# 文件\n\n正文'); await writeFile(external, '外部文档');
  await writeFile(join(root, 'image.png'), Buffer.from([137, 80, 78, 71]));
  const origin = await service.listen();
  const a = await service.openReader({ workspaceRoots: [root], path, targetLabel: '任务 A' });
  const b = await service.openReader({ workspaceRoots: [root] });
  const api = (session, endpoint, body = {}) => service.api(session.session, session.token, endpoint, body);
  assert.notEqual(a.session, b.session);
  assert.notEqual(a.token, b.token);
  await assert.rejects(service.api(a.session, b.token, '/api/context'), { status: 401 });
  await assert.rejects(service.api(a.session, '界'.repeat(64), '/api/context'), { status: 401 });
  assert.equal((await api(a, '/api/read', { path })).text, '# 文件\n\n正文');
  await assert.rejects(api(a, '/api/read', { path: external }), { status: 403 });
  const grant = await service.openReader({ workspaceRoots: [root], path: external });
  assert.equal((await api(grant, '/api/read', { path: external })).text, '外部文档');
  await writeFile(join(outside, 'sibling.md'), '不在文档授权内');
  await writeFile(join(outside, 'image.png'), 'external image');
  await assert.rejects(api(grant, '/api/read', { path: join(outside, 'sibling.md') }), { status: 403 });
  assert.equal((await api(grant, '/api/images/read', { documentPath: external, src: 'image.png' })).contentType, 'image/png');
  await assert.rejects(api(a, '/api/images/read', { documentPath: path, src: '../outside/image.png' }), { status: 403 });
  const junction = join(root, 'escape');
  await symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(api(a, '/api/read', { path: join(junction, 'external.md') }), { status: 403 });
  const listing = await api(a, '/api/files/list', { clientId: 'test', workspaceUris: [pathToFileURL(outside).href] });
  assert.deepEqual(listing.files.map(file => file.name), ['中文 空格.md']);
  const model = new PreviewSession();
  model.success(model.begin(path), await api(a, '/api/read', { path }));
  model.selectQuote('正文', a.session); model.addComment(a.session, true, '修改这段');
  const state = model.snapshot('', '统一修改', 125);
  assert.equal((await api(a, '/api/session/write', { conversationId: a.session, version: 0, state })).version, 1);
  assert.equal((await api(a, '/api/session/read', { conversationId: a.session })).state.comments[0].comment, '修改这段');
  assert.equal((await api(b, '/api/session/read', { conversationId: b.session })).state, null);
  await assert.rejects(api(b, '/api/session/read', { conversationId: a.session }), { status: 403 });
  await assert.rejects(api(a, '/api/session/write', { conversationId: a.session, version: 0, state }), { code: 'STATE_CONFLICT' });
  assert.equal(await model.sendBatch(async () => ({ isError: true }), a.session, true), 'rejected');
  assert.equal(model.comments.length, 1);
  const post = (headers = {}, body = '{}', endpoint = '/api/context') => fetch(origin + endpoint, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ClearPane-Session': a.session, 'X-ClearPane-Token': a.token, ...headers }, body });
  assert.equal((await post()).status, 200);
  assert.equal((await post({ 'X-ClearPane-Token': '' })).status, 401);
  assert.equal((await post({ Origin: 'https://untrusted.example' })).status, 403);
  const badHost = await new Promise((resolveResponse, reject) => {
    const req = request(origin, { headers: { Host: 'untrusted.example' } }, response => {
      response.resume(); resolveResponse(response.statusCode);
    });
    req.on('error', reject); req.end();
  });
  assert.equal(badHost, 403);
  assert.equal((await post({ 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({}, '{broken')).status, 400);
  assert.equal((await fetch(origin + '/api/context')).status, 405);
  assert.equal((await post({}, JSON.stringify({ documentPath: path, src: 'image.png' }), '/api/images/read')).headers.get('content-type'), 'image/png');
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(origin + '/mcp.html')).status, 404);
  assert.equal((await fetch(origin + '/service.mjs')).status, 404);
  now += 8 * 60 * 60 * 1000 + 1;
  await assert.rejects(api(a, '/api/context'), { status: 401 });
});

test('packaged stdio MCP opens readers and serves a self-contained UI', { timeout: 30000 }, async t => {
  const client = new Client({ name: 'clearpane-check', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/codex-clearpane/server.mjs')],
    cwd: tmpdir(), stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  t.after(() => client.close());
  await client.connect(transport);
  const identity = client.getServerVersion();
  assert.equal(identity.title, 'ClearPane');
  assert.match(identity.icons[0].src, /^data:image\/svg\+xml;base64,/);
  const manifest = JSON.parse(await readFile(resolve('dist/codex-clearpane/plugin.json'), 'utf8'));
  const presentation = manifest.extensions['com.openai'].interface;
  assert.equal(presentation.displayName, 'ClearPane');
  assert.equal(presentation.logo, './assets/logo.svg');
  assert.equal(await readFile(resolve('dist/codex-clearpane', presentation.logo), 'utf8'), await readFile(resolve('plugin/assets/logo.svg'), 'utf8'));
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name), ['open_reader', 'reader_api']);
  assert.deepEqual(tools.tools[1]._meta.ui.visibility, ['app']);
  const opened = await client.callTool({ name: 'open_reader', arguments: { workspaceRoots: [resolve('.')], path: resolve('README.md'), targetLabel: 'MCP 检查' } });
  assert.ok(!opened.isError, JSON.stringify(opened));
  const config = opened._meta.clearpane;
  assert.equal(config.targetLabel, 'MCP 检查');
  const read = await client.callTool({ name: 'reader_api', arguments: { session: config.session, token: config.token, endpoint: '/api/read', body: { path: config.initialPath } } });
  assert.match(read.structuredContent.text, /ClearPane/);
  const bad = await client.callTool({ name: 'reader_api', arguments: { session: config.session, token: '0'.repeat(64), endpoint: '/api/context' } });
  assert.equal(bad.isError, true);
  const resource = await client.readResource({ uri: tools.tools[0]._meta.ui.resourceUri });
  const html = resource.contents[0].text;
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(html, /id="copy-batch"/);
  assert.match(html, /data:font/);
  assert.doesNotMatch(html, /(?:src|href)="\/(?:assets|styles|preload)/);
  assert.equal((await fetch(config.url)).status, 200);
  assert.equal(stderr, '');
});

test('personal installer preserves other plugins and backs up updates', { timeout: 30000 }, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'clearpane-profile-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await mkdir(join(profile, '.agents/plugins'), { recursive: true });
  const catalog = join(profile, '.agents/plugins/marketplace.json');
  await writeFile(catalog, JSON.stringify({ name: 'mine', custom: true, plugins: [{ name: 'other' }] }));
  const run = promisify(execFile);
  const install = args => run(process.execPath, ['scripts/install-codex.mjs', '--home', profile, ...args], { windowsHide: true });
  await install([]);
  let marketplace = JSON.parse(await readFile(catalog));
  assert.equal(marketplace.plugins[0].name, 'other');
  assert.equal(marketplace.name, 'mine'); assert.equal(marketplace.custom, true);
  assert.equal(marketplace.plugins[1].source.path, './.codex/plugins/clearpane');
  await assert.rejects(install([]));
  await install(['--update']);
  marketplace = JSON.parse(await readFile(catalog));
  assert.equal(marketplace.plugins.length, 2);
  assert.match(await readFile(join(profile, '.codex/plugins/clearpane/server.mjs'), 'utf8'), /StdioServerTransport/);
});

test('packaged reader opens without MCP and survives its launcher', { timeout: 20000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'clearpane 中文 '));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const path = join(temporary, '手册 大纲.md');
  await writeFile(path, '# 手册\n\n可批注正文');
  const run = promisify(execFile);
  const start = resolve('dist/codex-clearpane/start.mjs');
  const { stdout } = await run(process.execPath, [start, '--background', temporary, path],
    { cwd: tmpdir(), windowsHide: true, timeout: 5000 });
  const { url, pid } = JSON.parse(stdout);
  t.after(() => { try { process.kill(pid); } catch {} });
  const location = new URL(url);
  const headers = { 'Content-Type': 'application/json',
    'X-ClearPane-Session': location.searchParams.get('session'),
    'X-ClearPane-Token': new URLSearchParams(location.hash.slice(1)).get('token') };
  assert.equal((await fetch(url)).status, 200);
  const context = await (await fetch(`${location.origin}/api/context`, { method: 'POST', headers, body: '{}' })).json();
  assert.equal(context.initialPath, path);
  const read = await (await fetch(`${location.origin}/api/read`, { method: 'POST', headers, body: JSON.stringify({ path }) })).json();
  assert.equal(read.text, '# 手册\n\n可批注正文');
  const invalid = join(temporary, '不存在.md');
  await assert.rejects(run(process.execPath, [start, '--background', temporary, invalid],
    { windowsHide: true, timeout: 5000 }), error => error.code === 1 && /文件不存在/.test(error.stderr));
});

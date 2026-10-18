import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import { readMarkdown } from './files.mjs';
import { readImage } from './images.mjs';
import { loadSettings, saveSettings } from './settings.mjs';
import { SessionCache } from './sessions.mjs';
import { WorkspaceFiles } from './workspace-files.mjs';

if (!process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || !process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  throw new Error('ClearPane requires the authenticated Antigravity sidecar environment.');
}
const here = dirname(fileURLToPath(import.meta.url));
const app = new SidecarApp();
const sessions = new SessionCache();
const workspaceFiles = new WorkspaceFiles();
const policy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src blob: http: https:; object-src 'none'; base-uri 'none'; form-action 'none'";
app.page('/', async () => new Response(await readFile(join(here, 'index.html'), 'utf8'), {
  contentType: 'text/html; charset=utf-8', headers: { 'Content-Security-Policy': policy, 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' },
}));
app.api('/styles.css', async () => new Response(await readFile(join(here, 'styles.css'), 'utf8'), { contentType: 'text/css' }), 'GET');
const types = { '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
// Register exact build assets, never accept a user-controlled filesystem path.
for (const name of await readdir(join(here, 'assets'))) {
  const type = types[extname(name)];
  if (extname(name) === '.js') app.page(`/assets/${name}`, () => readFile(join(here, 'assets', name), 'utf8'));
  else if (type) app.api(`/assets/${name}`, async () => new Response(await readFile(join(here, 'assets', name)), { contentType: type }), 'GET');
}
app.api('/api/read', async (data) => {
  try { return await readMarkdown(data.path); }
  catch (error) { return new Response(JSON.stringify({ error: error.message, code: error.code ?? 'READ_FAILED' }), { contentType: 'application/json', status: 400 }); }
});
app.api('/api/images/read', async data => {
  try {
    const { body, contentType } = await readImage(data.documentPath, data.src);
    return new Response(body, { contentType, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message, code: error.code ?? 'READ_FAILED' }), {
      contentType: 'application/json', status: 400,
    });
  }
});
app.api('/api/files/list', async data => {
  try { return await workspaceFiles.list(data); }
  catch (error) { return new Response(JSON.stringify({ error: error.message }), { contentType: 'application/json', status: 400 }); }
});
app.api('/api/settings/read', () => loadSettings(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR));
app.api('/api/settings/write', async (data) => {
  try { return await saveSettings(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR, data); }
  catch { return new Response(JSON.stringify({ error: '面板设置未保存，当前设置仍有效。' }), { contentType: 'application/json', status: 400 }); }
});
for (const action of ['read', 'write']) app.api(`/api/session/${action}`, data => {
  try { return sessions[action](data.conversationId, data.version, data.state); }
  catch (error) { return new Response(JSON.stringify({ error: error.message }), {
    contentType: 'application/json', status: error.code === 'STATE_CONFLICT' ? 409 : 400,
  }); }
});
await app.run();

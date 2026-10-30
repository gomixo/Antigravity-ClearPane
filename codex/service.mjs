import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { readMarkdown, validateLocalPath } from '../plugin/sidecars/panel/files.mjs';
import { readImage, resolveImagePath } from '../plugin/sidecars/panel/images.mjs';
import { WorkspaceFiles } from '../plugin/sidecars/panel/workspace-files.mjs';
import { SessionCache } from '../plugin/sidecars/panel/sessions.mjs';
import { loadSettings, saveSettings } from '../plugin/sidecars/panel/settings.mjs';

const ownDirectory = dirname(fileURLToPath(import.meta.url));
const inside = (root, file) => {
  const suffix = relative(root, file);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};
const equal = (left, right) => typeof left === 'string' && /^[a-f0-9]{64}$/.test(left) &&
  timingSafeEqual(Buffer.from(left), Buffer.from(right));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function createReaderService({ webDirectory = join(ownDirectory, 'web'),
  settingsDirectory = join(homedir(), '.codex', 'clearpane'), now = Date.now } = {}) {
  const readers = new Map();
  let origin;
  const clear = reader => {
    for (const client of reader.files.clients.keys()) reader.files.release(client);
    readers.delete(reader.id);
  };
  const lookup = (id, token) => {
    const reader = readers.get(id);
    if (!reader || !equal(token, reader.token)) throw fail('阅读会话凭证无效。', 401);
    if (now() - reader.touched > 8 * 60 * 60 * 1000) { clear(reader); throw fail('阅读会话已过期，请重新打开。', 401); }
    reader.touched = now();
    return reader;
  };
  const authorize = async (reader, path, image = false) => {
    validateLocalPath(path);
    const canonical = await realpath(path);
    validateLocalPath(canonical);
    const roots = image ? reader.imageRoots : reader.roots;
    if (!(reader.initialPath === canonical || roots.some(root => inside(root, canonical)))) throw fail('文件不在此阅读会话授权范围内。', 403);
    return canonical;
  };
  const context = reader => ({ session: reader.id, initialPath: reader.initialPath,
    workspaceUris: reader.roots.map(root => pathToFileURL(root).href), targetLabel: reader.targetLabel });

  async function openReader({ workspaceRoots, path, targetLabel = '当前阅读会话' }) {
    if (!Array.isArray(workspaceRoots) || !workspaceRoots.length || workspaceRoots.length > 64) throw fail('请提供 1–64 个工作区目录。');
    if (typeof targetLabel !== 'string' || !targetLabel.trim() || targetLabel.length > 200) throw fail('无效的阅读会话名称。');
    const roots = [];
    for (const root of workspaceRoots) {
      validateLocalPath(root);
      const canonical = await realpath(root);
      validateLocalPath(canonical);
      if (!(await stat(canonical)).isDirectory()) throw fail('工作区不是目录。');
      if (!roots.includes(canonical)) roots.push(canonical);
    }
    const reader = { id: randomUUID(), token: randomBytes(32).toString('hex'), roots,
      imageRoots: [...roots], initialPath: '', targetLabel: targetLabel.trim(), touched: now(),
      states: new SessionCache(), files: new WorkspaceFiles() };
    if (path) {
      // An explicitly opened document also authorizes its directory for referenced images.
      reader.initialPath = (await readMarkdown(path)).path;
      reader.imageRoots.push(dirname(reader.initialPath));
    }
    for (const existing of readers.values()) if (now() - existing.touched > 8 * 60 * 60 * 1000) clear(existing);
    // ponytail: at most 64 active readers; refuse new sessions instead of evicting unsent drafts.
    if (readers.size >= 64) throw fail('阅读会话已达 64 个上限，请复用已有链接，或保存评论后重启服务。');
    readers.set(reader.id, reader);
    return { ...context(reader), token: reader.token,
      url: `${origin}/?session=${reader.id}#token=${reader.token}` };
  }

  async function api(id, token, endpoint, body = {}) {
    const reader = lookup(id, token);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('无效请求。');
    if (Buffer.byteLength(JSON.stringify(body)) > 8 * 1024 * 1024) throw fail('请求过大。', 413);
    switch (endpoint) {
      case '/api/context': return context(reader);
      case '/api/read': {
        const document = await readMarkdown(await authorize(reader, body.path));
        await authorize(reader, document.path);
        return document;
      }
      case '/api/images/read': {
        const documentPath = await authorize(reader, body.documentPath);
        const imagePath = await authorize(reader, resolveImagePath(documentPath, body.src), true);
        const result = await readImage(documentPath, imagePath);
        return { binary: result.body.toString('base64'), contentType: result.contentType };
      }
      case '/api/files/list': {
        // Workspace roots are granted by the launching tool, never by an untrusted page body.
        const request = { ...body };
        if (request.workspaceUris !== undefined) request.workspaceUris = reader.roots.map(root => pathToFileURL(root).href);
        return reader.files.list(request);
      }
      case '/api/settings/read': return loadSettings(settingsDirectory);
      case '/api/settings/write': return saveSettings(settingsDirectory, body);
      case '/api/session/read':
      case '/api/session/write': {
        if (body.conversationId !== reader.id) throw fail('不能访问其他阅读会话。', 403);
        if (endpoint.endsWith('/read')) return reader.states.read(reader.id);
        if (body.state?.document) await authorize(reader, body.state.document.path);
        return reader.states.write(reader.id, body.version, body.state);
      }
      default: throw fail('不支持的阅读器操作。', 404);
    }
  }

  const http = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (request.headers.host !== new URL(origin).host) throw fail('无效主机。', 403);
      if (request.headers.origin && request.headers.origin !== origin) throw fail('禁止跨站请求。', 403);
      const url = new URL(request.url, origin);
      if (url.pathname.startsWith('/api/')) {
        if (request.method !== 'POST') throw fail('请使用 POST。', 405);
        if (!request.headers['content-type']?.startsWith('application/json')) throw fail('请使用 JSON。', 415);
        lookup(request.headers['x-clearpane-session'], request.headers['x-clearpane-token']);
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) throw fail('请求过大。', 413);
          chunks.push(chunk);
        }
        const result = await api(request.headers['x-clearpane-session'], request.headers['x-clearpane-token'],
          url.pathname, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        if (result.binary) {
          response.writeHead(200, { 'Content-Type': result.contentType }).end(Buffer.from(result.binary, 'base64'));
        } else response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(result));
        return;
      }
      if (request.method !== 'GET') throw fail('不支持此方法。', 405);
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^(index\.html|styles\.css|assets\/[\w.-]+)$/.test(name)) throw fail('页面不存在。', 404);
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }[extname(name)];
      if (!type) throw fail('资源不存在。', 404);
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src data:; connect-src 'self'; img-src blob: data: http: https:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      response.writeHead(200, { 'Content-Type': type }).end(await readFile(join(webDirectory, name)));
    } catch (error) {
      const status = error.status ?? (error.code === 'STATE_CONFLICT' ? 409 : error.code === 'ENOENT' ? 404 : 400);
      if (!response.headersSent) response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: status === 404 ? '文件或资源不存在。' : error.message, code: error.code }));
    }
  });
  http.requestTimeout = 15000;
  return {
    openReader, api,
    async listen() {
      await new Promise((resolveListen, reject) => {
        http.once('error', reject);
        http.listen(0, '127.0.0.1', resolveListen);
      });
      origin = `http://127.0.0.1:${http.address().port}`;
      return origin;
    },
    async close() {
      for (const reader of readers.values()) clear(reader);
      http.closeAllConnections();
      await new Promise(resolveClose => http.close(resolveClose));
    },
  };
}

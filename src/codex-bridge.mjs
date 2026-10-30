import { App } from '@modelcontextprotocol/ext-apps';

const apiTool = 'reader_api';
export async function initializeCodex() {
let config;
let app;
let configuredSession;
let sessionChanged = false;
const media = matchMedia('(prefers-color-scheme: dark)');
const bridge = {
  kind: 'codex', canSend: false, theme: media.matches ? 'dark' : 'light',
  sentNotice: '整批评论已交给宿主会话，请在会话中确认处理结果。',
};
const changeTheme = theme => {
  bridge.theme = theme ?? (media.matches ? 'dark' : 'light');
  bridge.onThemeChange?.();
};
media.addEventListener('change', () => changeTheme(app?.getHostContext()?.theme));

if (window.parent !== window) {
  app = new App({ name: 'ClearPane', version: '0.1.0' }, {}, { autoResize: false });
  let resolveConfig;
  let rejectConfig;
  const configured = new Promise((resolve, reject) => { resolveConfig = resolve; rejectConfig = reject; });
  // Connecting and waiting for tool output can fail independently.
  void configured.catch(() => {});
  const timer = setTimeout(() => rejectConfig(new Error('未收到阅读会话，请重新打开 ClearPane。')), 12000);
  app.ontoolresult = result => {
    const data = result._meta?.clearpane;
    if (!data) return;
    if (configuredSession && data.session !== configuredSession) {
      // A host may reuse an iframe for another tool call. Never send old drafts to its new target.
      sessionChanged = true;
      bridge.canSend = false;
      bridge.invalidated = true;
      bridge.conversationId = null;
      document.dispatchEvent(new Event('selectionchange'));
      document.getElementById('status').textContent = '宿主已切换阅读会话，请重新打开面板或使用新返回的阅读链接。';
      return;
    }
    configuredSession = data.session;
    clearTimeout(timer);
    resolveConfig(data);
  };
  app.onhostcontextchanged = context => changeTheme(context.theme);
  try {
    await app.connect(undefined, { timeout: 10000 });
    config = await configured;
  } finally { clearTimeout(timer); }
  bridge.canSend = !!app.getHostCapabilities()?.message?.text;
  changeTheme(app.getHostContext()?.theme);
} else {
  const params = new URLSearchParams(location.hash.slice(1));
  const session = new URLSearchParams(location.search).get('session');
  const key = `clearpane-token:${session}`;
  const token = params.get('token') ?? sessionStorage.getItem(key);
  if (!token || !session) throw new Error('缺少阅读会话凭证，请从 Codex 重新打开。');
  sessionStorage.setItem(key, token);
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  config = { session, token };
  const response = await fetch('/api/context', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-ClearPane-Session': session, 'X-ClearPane-Token': token,
  }, body: '{}' });
  if (!response.ok) throw new Error('阅读会话已失效，请从 Codex 重新打开。');
  Object.assign(config, await response.json());
}

Object.assign(bridge, {
  conversationId: config.session,
  initialPath: config.initialPath,
  targetLabel: config.targetLabel,
  getWorkspaceUris: async () => config.workspaceUris,
  async fetch(path, options = {}) {
    if (sessionChanged) throw new Error('宿主已切换阅读会话，请重新打开面板或使用新返回的阅读链接。');
    if (!path.startsWith('/api/')) throw new Error('无效的阅读器请求。');
    if (!app) return fetch(path, { ...options, headers: { ...options.headers,
      'Content-Type': 'application/json', 'X-ClearPane-Session': config.session, 'X-ClearPane-Token': config.token,
    } });
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const result = await app.callServerTool({ name: apiTool, arguments: {
      session: config.session, token: config.token, endpoint: path, body: JSON.parse(options.body ?? '{}'),
    } }, { signal: options.signal, timeout: 12000 });
    if (result.isError) return new Response(JSON.stringify({ error: result.content?.[0]?.text ?? '读取失败' }), { status: 400 });
    const payload = result.structuredContent;
    if (payload.binary) {
      const bytes = Uint8Array.from(atob(payload.binary), value => value.charCodeAt(0));
      return new Response(bytes, { headers: { 'Content-Type': payload.contentType } });
    }
    return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
  },
  agent: { async sendMessage(message, id) {
    if (sessionChanged || !app || !bridge.canSend || id !== config.session) return { error: '当前宿主不支持向此会话发送消息。' };
    return app.sendMessage({ role: 'user', content: [{ type: 'text', text: message }] }, { timeout: 12000 });
  } },
});
window.clearpane = bridge;
await import('./app.js');
}

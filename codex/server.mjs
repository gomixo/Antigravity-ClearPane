import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReaderService } from './service.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const service = createReaderService();
await service.listen();
const logo = await readFile(join(directory, 'assets/logo.svg')).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return readFile(join(directory, '../plugin/assets/logo.svg'));
});
const server = new McpServer({ name: 'clearpane', title: 'ClearPane', version: '0.1.2',
  icons: [{ src: `data:image/svg+xml;base64,${logo.toString('base64')}`, mimeType: 'image/svg+xml', sizes: ['any'] }] }, {
  instructions: 'Open Markdown review sessions with open_reader. Its URL opens in the Codex built-in browser if MCP UI is unavailable. reader_api requires session credentials and is for the reader UI. Comments remain drafts until a person explicitly sends or copies them.',
});
const resourceUri = 'ui://clearpane/reader-v1.html';
const annotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
server.registerResource('reader', resourceUri, { mimeType: 'text/html;profile=mcp-app' }, async () => ({ contents: [{
  uri: resourceUri, mimeType: 'text/html;profile=mcp-app', text: await readFile(join(directory, 'web', 'mcp.html'), 'utf8'),
  _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
}] }));
server.registerTool('open_reader', {
  title: '打开 ClearPane', description: 'Open a read-only local Markdown reader with review drafts, file search and batch comments. Pass the current task workspace roots explicitly. A path outside those roots grants that document and its directory for referenced images. Returns an optional MCP UI and a local browser URL. Does not send messages.',
  inputSchema: { workspaceRoots: z.array(z.string().min(1).max(32768)).min(1).max(64),
    path: z.string().min(1).max(32768).optional(), targetLabel: z.string().min(1).max(200).optional() }, annotations,
  _meta: { ui: { resourceUri } },
}, async args => {
  try {
    const config = await service.openReader(args);
    return { content: [{ type: 'text', text: `ClearPane 已就绪。若未显示阅读面板，请在当前聊天的内置浏览器打开此本地链接：${config.url}\n复制评论后需粘贴到目标聊天发送；宿主支持 MCP 消息时可在面板统一发送。` }],
      structuredContent: { url: config.url, targetLabel: config.targetLabel }, _meta: { clearpane: config } };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
server.registerTool('reader_api', {
  title: 'ClearPane 阅读器操作', description: 'Authenticated operations for one explicitly opened ClearPane reader session. Does not send agent messages or edit source documents.',
  inputSchema: { session: z.string().uuid(), token: z.string().regex(/^[a-f0-9]{64}$/),
    endpoint: z.enum(['/api/context', '/api/read', '/api/images/read', '/api/files/list', '/api/settings/read', '/api/settings/write', '/api/session/read', '/api/session/write']),
    body: z.record(z.string(), z.unknown()).optional() },
  annotations, _meta: { ui: { visibility: ['app'] } },
}, async args => {
  try {
    const result = await service.api(args.session, args.token, args.endpoint, args.body);
    return { structuredContent: result, content: [] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
const shutdown = async () => { await service.close(); await server.close(); };
process.on('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
process.stdin.on('end', () => { void shutdown(); });
await server.connect(new StdioServerTransport());

import { resolve } from 'node:path';
import { fork } from 'node:child_process';
import { createReaderService } from './service.mjs';

const args = process.argv.slice(2);
if (args[0] === '--background') {
  const child = fork(process.argv[1], args.slice(1), { detached: true, windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const result = await new Promise((ready, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('ClearPane 启动超时。')); }, 10000);
    const fail = error => { clearTimeout(timer); reject(error); };
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`ClearPane 未就绪就退出：${code}`)));
    child.once('message', message => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error));
      else ready(message);
    });
  });
  child.unref();
  console.log(JSON.stringify(result));
} else {
  const [root = process.cwd(), path] = args;
  const background = Boolean(process.send);
  const service = createReaderService();
  try {
    await service.listen();
    const session = await service.openReader({ workspaceRoots: [resolve(root)], path: path ? resolve(root, path) : undefined,
      targetLabel: '独立阅读 · 复制评论到 Codex' });
    if (background) {
      process.send({ url: session.url, pid: process.pid }, () => process.disconnect());
      // ponytail: one process per fallback opening, capped at eight hours; MCP remains the normal route.
      setTimeout(() => { void service.close(); }, 8 * 60 * 60 * 1000).unref();
    } else console.log(session.url);
  } catch (error) {
    await service.close();
    if (background) process.send({ error: error.message }, () => process.disconnect());
    else console.error(error.message);
    process.exitCode = 1;
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void service.close().finally(() => process.exit(0)); });
}

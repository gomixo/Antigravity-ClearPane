import { cp, mkdir, access, readFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../plugin/', import.meta.url));
const target = resolve(homedir(), '.gemini', 'config', 'plugins', 'antigravity-clearpane');
const parent = join(homedir(), '.gemini', 'config', 'plugins');
await mkdir(parent, { recursive: true });
await access(join(source, 'sidecars', 'panel', 'assets', 'app.js'));
let exists = false;
try { await access(target); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
let backup;
if (exists) {
  if (!process.argv.includes('--update')) throw new Error('同名目录已存在。先停用插件，再使用 npm run install:local -- --update 备份更新。');
  const actual = await realpath(target);
  if (actual.toLowerCase() !== target.toLowerCase()) throw new Error('目标目录是链接，拒绝移动或覆盖。');
  const manifest = JSON.parse(await readFile(join(target, 'plugin.json'), 'utf8'));
  if (manifest.name !== 'antigravity-clearpane') throw new Error('同名目录的插件标识不匹配，拒绝覆盖。');
  const backupRoot = resolve(homedir(), '.gemini', 'config', 'clearpane-backups');
  await mkdir(backupRoot, { recursive: true });
  backup = join(backupRoot, `antigravity-clearpane-${Date.now()}`);
  // Windows clients can keep a directory watcher open after sidecar shutdown.
  // Back up first, then replace files without moving the watched directory.
  await cp(target, backup, { recursive: true, errorOnExist: true, force: false });
}
try {
  await cp(source, target, { recursive: true, errorOnExist: !exists, force: exists });
  // The M1 entrypoint is obsolete; copying newer files alone leaves it installed.
  await rm(join(target, 'sidecars', 'panel', 'app.js'), { force: true });
}
catch (error) {
  if (backup) await cp(backup, target, { recursive: true, force: true });
  throw error;
}
console.log(`已复制 ClearPane 到 ${target}。${backup ? `原插件已备份到 ${backup}。` : ''}在 Installed 启用后，在会话 ⋮ → Extensions 打开。`);

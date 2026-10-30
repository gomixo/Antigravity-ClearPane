import { access, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../dist/codex-clearpane/', import.meta.url));
// --home is useful for portable profiles and installation checks.
const homeIndex = process.argv.indexOf('--home');
if (homeIndex >= 0 && !process.argv[homeIndex + 1]) throw new Error('--home 需要一个目录。');
const profile = resolve(homeIndex >= 0 ? process.argv[homeIndex + 1] : homedir());
const target = join(profile, '.codex/plugins/clearpane');
const catalog = join(profile, '.agents/plugins/marketplace.json');
await access(join(source, 'server.mjs'));
let marketplace;
try { marketplace = JSON.parse(await readFile(catalog, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
marketplace ??= { name: 'local-personal', interface: { displayName: '本地插件' }, plugins: [] };
if (!Array.isArray(marketplace.plugins) || typeof marketplace.name !== 'string') throw new Error('现有 marketplace.json 格式无效，未修改。');
const previous = marketplace.plugins.find(entry => entry.name === 'clearpane');
if (previous && !process.argv.includes('--update')) throw new Error('ClearPane 已在目录中，使用 --update 备份更新。');
let installed = false;
try { await access(target); installed = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
const backup = join(profile, '.codex/clearpane-backups', String(Date.now()));
if (installed) {
  if (!process.argv.includes('--update')) throw new Error('ClearPane 目录已存在，使用 --update 备份更新。');
  if ((await realpath(target)).toLowerCase() !== target.toLowerCase()) throw new Error('插件目录是链接，拒绝覆盖。');
  if (JSON.parse(await readFile(join(target, 'plugin.json'), 'utf8')).name !== 'clearpane') throw new Error('插件标识不匹配。');
  await mkdir(backup, { recursive: true });
  await cp(target, join(backup, 'plugin'), { recursive: true });
}
await mkdir(join(profile, '.agents/plugins'), { recursive: true });
try { await access(catalog); await mkdir(backup, { recursive: true }); await cp(catalog, join(backup, 'marketplace.json')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(join(profile, '.codex/plugins'), { recursive: true });
await cp(source, target, { recursive: true, errorOnExist: !installed, force: installed });
const entry = { name: 'clearpane', source: { source: 'local', path: './.codex/plugins/clearpane' },
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' };
if (previous) marketplace.plugins[marketplace.plugins.indexOf(previous)] = { ...previous, ...entry };
else marketplace.plugins.push(entry);
await writeFile(catalog, JSON.stringify(marketplace, null, 2) + '\n');
console.log(`已准备 ${target}。在插件目录的 ${marketplace.name} 来源中安装并启用 ClearPane，然后新建聊天；必要时重启桌面应用。`);

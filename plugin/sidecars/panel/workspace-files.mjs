import { readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const skipped = new Set(['.git', 'node_modules', '.cache']);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const local = value => path.isAbsolute(value) && !value.includes('\0') && !/^[\\/]{2}/.test(value) &&
  (process.platform !== 'win32' || (/^[a-z]:[\\/]/i.test(value) && !value.slice(2).includes(':')));

export async function scanMarkdown(uris) {
  if (!Array.isArray(uris) || uris.length > 64 || uris.some(uri => typeof uri !== 'string' || uri.length > 32768)) {
    throw new Error('无效的工作区目录。');
  }
  const roots = new Set();
  const files = new Map();
  let warnings = 0;
  for (const uri of uris) {
    let root;
    try {
      root = fileURLToPath(uri);
      if (!local(root)) throw new Error();
      const stat = await lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
      root = await realpath(root);
      if (!local(root)) throw new Error();
    } catch { warnings++; continue; }
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    if (roots.has(key)) continue;
    roots.add(key);
    const visit = async directory => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch { warnings++; return; }
      // ponytail: sequential metadata reads; add bounded concurrency only if large workspaces prove slow.
      for (const entry of entries) {
        if (entry.isSymbolicLink() || (entry.isDirectory() && skipped.has(entry.name.toLowerCase()))) continue;
        if (!entry.isDirectory() && !(entry.isFile() && /\.(md|markdown)$/i.test(entry.name))) continue;
        try {
          const candidate = path.join(directory, entry.name);
          const stat = await lstat(candidate);
          if (stat.isSymbolicLink()) continue;
          const canonical = await realpath(candidate);
          if (!local(canonical) || !inside(root, canonical)) continue;
          if (stat.isDirectory()) await visit(canonical);
          else if (stat.isFile()) {
            const fileKey = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
            if (!files.has(fileKey)) files.set(fileKey, { path: canonical, name: entry.name,
              relativePath: path.relative(root, canonical), workspace: path.basename(root), modifiedAt: stat.mtimeMs });
          }
        } catch { warnings++; }
      }
    };
    await visit(root);
  }
  return { files: [...files.values()].sort((a, b) => b.modifiedAt - a.modifiedAt ||
    a.relativePath.localeCompare(b.relativePath, 'zh-CN') || a.path.localeCompare(b.path, 'zh-CN')), warnings };
}

export class WorkspaceFiles {
  clients = new Map();
  async list(data) {
    if (!data || typeof data.clientId !== 'string' || !/^[\w-]{1,128}$/.test(data.clientId)) throw new Error('无效的列表标识。');
    const client = data.clientId;
    if (data.release === true) {
      if (data.snapshot === this.clients.get(client)?.snapshot) this.release(client);
      return { released: true };
    }
    const query = data.query ?? '';
    const offset = data.offset ?? 0;
    if (typeof query !== 'string' || query.length > 256 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('无效的搜索或分页。');
    let entry = this.clients.get(client);
    if (data.workspaceUris !== undefined) {
      if (data.snapshot !== undefined && (typeof data.snapshot !== 'string' || !/^[\w-]{1,128}$/.test(data.snapshot))) throw new Error('无效的快照标识。');
      this.release(client);
      entry = { snapshot: data.snapshot ?? randomUUID(), files: [], warnings: 0 };
      this.clients.set(client, entry);
      // Expiry also releases snapshots when an iframe disappears without delivering pagehide.
      entry.timer = setTimeout(() => { if (this.clients.get(client) === entry) this.release(client); }, 30 * 60 * 1000);
      entry.timer.unref();
      try { Object.assign(entry, await scanMarkdown(data.workspaceUris)); }
      catch (error) { if (this.clients.get(client) === entry) this.release(client); throw error; }
      if (this.clients.get(client) !== entry) throw new Error('列表请求已被替换，请重新加载。');
    } else if (!entry || data.snapshot !== entry.snapshot) throw new Error('列表已过期，请重新加载。');
    const needle = query.trim().toLowerCase();
    const matches = entry.files.filter(file => !needle || `${file.name}\n${file.relativePath}`.toLowerCase().includes(needle));
    return { snapshot: entry.snapshot, files: matches.slice(offset, offset + 3),
      nextOffset: offset + 3 < matches.length ? offset + 3 : null, total: matches.length, warnings: entry.warnings };
  }
  release(client) { clearTimeout(this.clients.get(client)?.timer); this.clients.delete(client); }
}

import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

export const MAX_BYTES = 1024 * 1024;
export class FileError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function validateLocalPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) {
    throw new FileError('INVALID_PATH', '请输入本地 Markdown 完整路径。');
  }
  if (/^[\\/]{2}/.test(value) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(value))) {
    throw new FileError('UNSUPPORTED_PATH', '首版仅支持 Windows 本地磁盘文件。');
  }
  if (process.platform === 'win32' && value.slice(2).includes(':')) {
    throw new FileError('UNSUPPORTED_PATH', '不支持设备路径或文件数据流。');
  }
}

function validatePath(value) {
  validateLocalPath(value);
  if (!/\.(md|markdown)$/i.test(value)) {
    throw new FileError('UNSUPPORTED_TYPE', '请选择 .md 或 .markdown 文件。');
  }
}

export async function readBounded(handle, limit, message) {
  const stat = await handle.stat();
  if (!stat.isFile()) throw new FileError('NOT_FILE', '所选路径不是普通文件。');
  if (stat.size > limit) throw new FileError('TOO_LARGE', message);
  const buffer = Buffer.alloc(stat.size + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
    if (!bytesRead) return buffer.subarray(0, total);
    total += bytesRead;
  }
  // A growing file must not bypass the limit or return a truncated image/document.
  throw new FileError(total > limit ? 'TOO_LARGE' : 'FILE_CHANGED', total > limit ? message : '文件读取时发生变化，请重试。');
}

export async function readMarkdown(value) {
  validatePath(value);
  let handle;
  try {
    const canonical = await realpath(value);
    validatePath(canonical);
    handle = await open(canonical, 'r');
    const buffer = await readBounded(handle, MAX_BYTES, '文件超过 1 MiB，无法预览。');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { throw new FileError('INVALID_UTF8', '文件不是有效的 UTF-8 编码。'); }
    return { path: canonical, name: path.basename(canonical), text, checkedAt: new Date().toISOString() };
  } catch (error) {
    if (error instanceof FileError) throw error;
    if (error.code === 'ENOENT') throw new FileError('NOT_FOUND', '文件不存在或已删除。');
    if (['EACCES', 'EPERM'].includes(error.code)) throw new FileError('ACCESS_DENIED', '无法读取文件，请检查权限或占用情况。');
    throw new FileError('READ_FAILED', '读取失败，请重试。');
  } finally { await handle?.close(); }
}

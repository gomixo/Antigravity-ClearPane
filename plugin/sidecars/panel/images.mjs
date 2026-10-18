import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileError, validateLocalPath, readBounded } from './files.mjs';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.avif': 'image/avif', '.ico': 'image/x-icon' };

export function resolveImagePath(documentPath, src) {
  validateLocalPath(documentPath);
  if (!/\.(md|markdown)$/i.test(documentPath) || typeof src !== 'string' || !src ||
    src.length > 32768 || /[\u0000-\u001f\u007f]/.test(src)) {
    throw new FileError('INVALID_PATH', '无效的本地图片路径。');
  }
  let target;
  try {
    if (/^file:/i.test(src)) {
      const url = new URL(src);
      if (url.hostname || url.search || url.hash) throw new Error('Not a local file URI');
      target = fileURLToPath(url);
    } else {
      target = decodeURIComponent(src);
    }
  } catch { throw new FileError('INVALID_PATH', '无效的本地图片路径。'); }
  if (/^[\\/]{2}/.test(target) ||
    (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) ||
    (process.platform === 'win32' && !path.isAbsolute(target) && target.includes(':'))) {
    throw new FileError('UNSUPPORTED_PATH', '仅支持本地磁盘图片。');
  }
  // Reject drive-relative/root-relative Windows paths instead of borrowing the server's drive.
  if (process.platform === 'win32' && /^[\\/]/.test(target) && !/^[a-z]:[\\/]/i.test(target)) {
    throw new FileError('UNSUPPORTED_PATH', '请使用相对路径或包含盘符的完整路径。');
  }
  target = path.resolve(path.dirname(documentPath), target);
  validateLocalPath(target);
  return target;
}

export async function readImage(documentPath, src) {
  const target = resolveImagePath(documentPath, src);
  let handle;
  try {
    const canonical = await realpath(target);
    validateLocalPath(canonical);
    const contentType = types[path.extname(canonical).toLowerCase()];
    if (!contentType) throw new FileError('UNSUPPORTED_TYPE', '不支持此图片格式。');
    handle = await open(canonical, 'r');
    const body = await readBounded(handle, MAX_IMAGE_BYTES, '图片超过 20 MiB，无法预览。');
    return { body, contentType };
  } catch (error) {
    if (error instanceof FileError) throw error;
    if (error.code === 'ENOENT') throw new FileError('NOT_FOUND', '图片不存在或已删除。');
    if (['EACCES', 'EPERM'].includes(error.code)) throw new FileError('ACCESS_DENIED', '无法读取图片，请检查权限。');
    throw new FileError('READ_FAILED', '图片读取失败，请重试。');
  } finally { await handle?.close(); }
}

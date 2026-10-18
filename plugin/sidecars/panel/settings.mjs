import { open, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_SETTINGS = Object.freeze({ fontSize: 16, lineHeight: 1.8, colorMode: 'system' });
export function validateSettings(data) {
  if (!data || !Number.isInteger(data.fontSize) || data.fontSize < 14 || data.fontSize > 22 ||
      typeof data.lineHeight !== 'number' || !Number.isFinite(data.lineHeight) || data.lineHeight < 1.4 || data.lineHeight > 2.2 ||
      !['system', 'light', 'dark'].includes(data.colorMode === undefined ? 'system' : data.colorMode)) {
    throw new Error('面板设置超出支持范围。');
  }
  return { fontSize: data.fontSize, lineHeight: data.lineHeight, colorMode: data.colorMode ?? 'system' };
}
export async function loadSettings(directory) {
  if (!directory) return { ...DEFAULT_SETTINGS };
  let handle;
  try {
    handle = await open(join(directory, 'settings.json'), 'r');
    if ((await handle.stat()).size > 4096) return { ...DEFAULT_SETTINGS };
    return validateSettings(JSON.parse(await handle.readFile('utf8')));
  } catch { return { ...DEFAULT_SETTINGS }; }
  finally { await handle?.close(); }
}
export async function saveSettings(directory, data) {
  const settings = validateSettings(data);
  if (!directory) throw new Error('宿主没有提供设置目录，当前排版未保存。');
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `settings-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(settings), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, join(directory, 'settings.json'));
  } finally { await rm(temporary, { force: true }); }
  return settings;
}

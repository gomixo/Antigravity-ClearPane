import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMarkdown, readBounded, MAX_BYTES } from '../plugin/sidecars/panel/files.mjs';

test('strict bounded reads, replacement, same-length refresh and recoverable failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clearpane-'));
  const file = join(directory, '中文 空格.md');
  try {
    await writeFile(file, '\ufeff# 你好\r\n内容 A');
    assert.equal((await readMarkdown(file)).text, '# 你好\r\n内容 A');
    await writeFile(file, '# 你好\r\n内容 B');
    assert.equal((await readMarkdown(file)).text, '# 你好\r\n内容 B');
    const replacement = join(directory, 'replacement.md');
    await writeFile(replacement, '替换');
    await rename(replacement, file);
    assert.equal((await readMarkdown(file)).text, '替换');
    await writeFile(file, '');
    assert.equal((await readMarkdown(file)).text, '');
    await writeFile(file, Buffer.from([0xc3, 0x28]));
    await assert.rejects(readMarkdown(file), { code: 'INVALID_UTF8' });
    await writeFile(file, Buffer.alloc(MAX_BYTES + 1));
    await assert.rejects(readMarkdown(file), { code: 'TOO_LARGE' });
    await rm(file);
    await assert.rejects(readMarkdown(file), { code: 'NOT_FOUND' });
    await writeFile(file, '重建');
    assert.equal((await readMarkdown(file)).text, '重建');
    await mkdir(join(directory, 'folder.md'));
    await assert.rejects(readMarkdown(join(directory, 'folder.md')), { code: 'NOT_FILE' });
    await assert.rejects(readMarkdown('relative.md'), { code: 'INVALID_PATH' });
    await assert.rejects(readMarkdown(join(directory, 'file.txt')), { code: 'UNSUPPORTED_TYPE' });
    await assert.rejects(readMarkdown('\\\\server\\share\\file.md'), { code: 'UNSUPPORTED_PATH' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('bounded reads reject files that grow during reading instead of returning truncated bytes', async () => {
  const handle = size => ({
    stat: async () => ({ isFile: () => true, size }),
    read: async (buffer, offset, length) => { buffer.fill(1, offset, offset + length); return { bytesRead: length }; },
  });
  await assert.rejects(readBounded(handle(2), 4, 'too large'), { code: 'FILE_CHANGED' });
  await assert.rejects(readBounded(handle(4), 4, 'too large'), { code: 'TOO_LARGE' });
});

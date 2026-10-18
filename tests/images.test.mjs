import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, open, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readImage, resolveImagePath, MAX_IMAGE_BYTES } from '../plugin/sidecars/panel/images.mjs';

test('local images resolve encoded paths and enforce file type, disk paths and size', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'clearpane-images-'));
  const article = join(directory, '文章.md');
  const image = join(directory, '中文 空格 #%.png');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64');
  try {
    await writeFile(article, '# 图片');
    await writeFile(image, png);
    await mkdir(join(directory, 'nested'));
    for (const src of [encodeURIComponent('中文 空格 #%.png'), image.replace('%', '%25'), pathToFileURL(image).href, './nested/../' + encodeURIComponent('中文 空格 #%.png')]) {
      const result = await readImage(article, src);
      assert.equal(result.contentType, 'image/png');
      assert.deepEqual(result.body, png);
    }
    assert.deepEqual((await readImage(join(directory, 'nested/a.md'), '../' + encodeURIComponent('中文 空格 #%.png'))).body, png);
    for (const [ext, contentType] of Object.entries({ jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon' })) {
      await writeFile(join(directory, 'a.' + ext), 'fixture');
      assert.equal((await readImage(article, './a.' + ext)).contentType, contentType);
    }
    await assert.rejects(readImage(article, './missing.png'), { code: 'NOT_FOUND' });
    await writeFile(join(directory, 'secret.txt'), 'not an image');
    await assert.rejects(readImage(article, './secret.txt'), { code: 'UNSUPPORTED_TYPE' });
    await mkdir(join(directory, 'folder.png'));
    await assert.rejects(readImage(article, './folder.png'), { code: 'NOT_FILE' });
    const large = await open(join(directory, 'large.png'), 'w');
    try {
      await large.truncate(MAX_IMAGE_BYTES);
      assert.equal((await readImage(article, './large.png')).body.length, MAX_IMAGE_BYTES);
      await large.truncate(MAX_IMAGE_BYTES + 1);
      await assert.rejects(readImage(article, './large.png'), { code: 'TOO_LARGE' });
    } finally { await large.close(); }
    for (const src of ['https://example.com/a.png', 'data:image/png,a', '\\\\server\\share\\a.png', '//server/a.png',
      'file://server/share/a.png', '\\\\?\\C:\\a.png', '\\\\.\\C:\\a.png', 'C:relative.png', 'a.png:stream', '%00.png', '%ZZ.png', '%2f%2fserver/a.png']) {
      assert.throws(() => resolveImagePath(article, src), undefined, src);
    }
    if (process.platform === 'win32') {
      assert.throws(() => resolveImagePath(article, 'C:/a.png:stream'));
      assert.throws(() => resolveImagePath(article, '/a.png'));
    }
    assert.throws(() => resolveImagePath('relative.md', './a.png'));
    assert.throws(() => resolveImagePath(article, null));
    assert.throws(() => resolveImagePath(article, '../a\0.png'));
    try {
      await symlink(join(directory, 'secret.txt'), join(directory, 'link.png'));
      await assert.rejects(readImage(article, './link.png'), { code: 'UNSUPPORTED_TYPE' });
    } catch (error) {
      if (error.code !== 'EPERM') throw error;
      t.diagnostic('File symlink check unavailable without Windows symlink permission');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

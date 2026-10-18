import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanMarkdown, WorkspaceFiles } from '../plugin/sidecars/panel/workspace-files.mjs';

test('recursive workspace metadata, stable paging, full search, links, failures and snapshot release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clearpane-list-'));
  const root = join(directory, '中文 工作区');
  const other = join(directory, 'other');
  const lists = new WorkspaceFiles();
  try {
    await mkdir(join(root, 'nested'), { recursive: true });
    await mkdir(other);
    for (const name of ['.git', 'node_modules', '.cache']) {
      await mkdir(join(root, name)); await writeFile(join(root, name, 'hidden.md'), '');
    }
    for (let i = 0; i < 7; i++) {
      const file = join(root, i === 0 ? 'nested' : '', `${i} 中文.${i === 0 ? 'MARKDOWN' : 'md'}`);
      await writeFile(file, '正文不进入列表');
      await utimes(file, new Date(10000 + i * 1000), new Date(10000 + i * 1000));
    }
    await writeFile(join(root, 'ignored.txt'), '');
    await writeFile(join(other, 'outside.md'), '');
    await symlink(other, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const uri = pathToFileURL(root).href;
    const scanned = await scanMarkdown([uri, uri, 'https://invalid.test', pathToFileURL(join(directory, 'missing')).href]);
    assert.equal(scanned.files.length, 7);
    assert.equal(scanned.warnings, 2);
    assert.equal(scanned.files[0].name, '6 中文.md');
    assert.ok(scanned.files.every(file => !('text' in file)));
    const first = await lists.list({ clientId: 'a', workspaceUris: [uri] });
    assert.equal(first.files.length, 3); assert.equal(first.nextOffset, 3); assert.equal(first.total, 7);
    await writeFile(join(root, 'new.md'), '');
    const second = await lists.list({ clientId: 'a', snapshot: first.snapshot, offset: 3 });
    assert.deepEqual(second.files.map(file => file.name), ['3 中文.md', '2 中文.md', '1 中文.md']);
    const last = await lists.list({ clientId: 'a', snapshot: first.snapshot, offset: 6 });
    assert.equal(last.files.length, 1); assert.equal(last.nextOffset, null);
    const found = await lists.list({ clientId: 'a', snapshot: first.snapshot, query: 'NESTED' });
    assert.equal(found.total, 1); assert.equal(found.files[0].name, '0 中文.MARKDOWN');
    assert.equal((await lists.list({ clientId: 'a', snapshot: first.snapshot, query: 'absent' })).total, 0);
    const replacement = await lists.list({ clientId: 'a', workspaceUris: [uri, pathToFileURL(other).href] });
    assert.equal(replacement.total, 9);
    await lists.list({ clientId: 'a', snapshot: first.snapshot, release: true });
    assert.ok(lists.clients.has('a'), 'late release removed new snapshot');
    await assert.rejects(lists.list({ clientId: 'a', snapshot: first.snapshot }), /过期/);
    await lists.list({ clientId: 'a', snapshot: replacement.snapshot, release: true });
    assert.equal(lists.clients.size, 0);
    await assert.rejects(lists.list({ clientId: 'a', workspaceUris: 'invalid' }), /工作区/);
    await assert.rejects(lists.list({ clientId: 'a', offset: -1 }), /分页/);
    await assert.rejects(lists.list({ clientId: '../bad' }), /标识/);
    const sameTime = join(other, 'a.md');
    await writeFile(sameTime, ''); await utimes(sameTime, new Date(16000), new Date(16000));
    const sorted = await scanMarkdown([uri, pathToFileURL(other).href]);
    const tied = sorted.files.filter(file => file.modifiedAt === 16000);
    assert.deepEqual(tied.map(file => file.relativePath), [...tied.map(file => file.relativePath)].sort((a,b)=>a.localeCompare(b,'zh-CN')));
  } finally {
    for (const client of lists.clients.keys()) lists.release(client);
    await rm(directory, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSettings, saveSettings, validateSettings } from '../plugin/sidecars/panel/settings.mjs';

test('settings persist typography and color mode, recover from corruption, and reject invalid values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clearpane-settings-'));
  try {
    assert.deepEqual(await loadSettings(directory), { fontSize: 16, lineHeight: 1.8, colorMode: 'system' });
    await saveSettings(directory, { fontSize: 22, lineHeight: 2.2, text: 'must not save', path: 'private' });
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')), { fontSize: 22, lineHeight: 2.2, colorMode: 'system' });
    assert.deepEqual(await loadSettings(directory), { fontSize: 22, lineHeight: 2.2, colorMode: 'system' });
    await saveSettings(directory, { fontSize: 14, lineHeight: 1.4 });
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ fontSize: 18, lineHeight: 2 }));
    assert.deepEqual(await loadSettings(directory), { fontSize: 18, lineHeight: 2, colorMode: 'system' });
    for (const colorMode of ['system', 'light', 'dark']) {
      await saveSettings(directory, { fontSize: 18, lineHeight: 2, colorMode, comment: 'private' });
      assert.deepEqual(await loadSettings(directory), { fontSize: 18, lineHeight: 2, colorMode });
      assert.deepEqual(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')), { fontSize: 18, lineHeight: 2, colorMode });
    }
    for (const colorMode of ['auto', '', null, 1]) assert.throws(() => validateSettings({ fontSize: 16, lineHeight: 1.8, colorMode }));
    await writeFile(join(directory, 'settings.json'), 'invalid');
    assert.deepEqual(await loadSettings(directory), { fontSize: 16, lineHeight: 1.8, colorMode: 'system' });
    for (const data of [{ fontSize: 13, lineHeight: 1.8 }, { fontSize: 16, lineHeight: NaN }, { fontSize: 16, lineHeight: 3 }]) assert.throws(() => validateSettings(data));
    await assert.rejects(saveSettings(null, { fontSize: 16, lineHeight: 1.8, colorMode: 'system' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

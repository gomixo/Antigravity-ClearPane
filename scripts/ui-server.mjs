// Browser acceptance only. Uses the installed first-party SDK; never ships in the plugin.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const data = await mkdtemp(join(tmpdir(), 'clearpane-ui-'));
const token = randomUUID();
const loader = pathToFileURL(join(homedir(), '.gemini/config/node_modules/sidecar_sdk/register_loader.js')).href;
const child = spawn(process.execPath, ['--import', loader, fileURLToPath(new URL('../plugin/sidecars/panel/main.mjs', import.meta.url))], {
  windowsHide: true, env: { ...process.env, ANTIGRAVITY_SIDECAR_WEB_PORT: '0', ANTIGRAVITY_SIDECAR_UI_TOKEN: token,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: data, ANTIGRAVITY_LS_ADDRESS: 'isolated-ui-test', ANTIGRAVITY_CSRF_TOKEN: randomUUID() },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', bytes => {
  const port = String(bytes).match(/listening on 127\.0\.0\.1:(\d+)/)?.[1];
  if (port) console.log(`UI test server ready on port ${port}.`);
});
// The test token is only handed to the browser URL in local memory, never printed.
import { writeFile, mkdir } from 'node:fs/promises';
await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
child.stdout.on('data', async bytes => {
  const port = String(bytes).match(/listening on 127\.0\.0\.1:(\d+)/)?.[1];
  if (port) await writeFile(new URL('../.local/ui-url.txt', import.meta.url), `http://127.0.0.1:${port}/?token=${token}`);
});
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', async code => { await rm(data, { recursive: true, force: true }); process.exit(code ?? 0); });

import { build } from 'esbuild';
import { mkdir, rm, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, dirname, join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = resolve(root, 'plugin/sidecars/panel/assets');
if (relative(root, assets).startsWith('..')) throw new Error('Build path escaped workspace');
await rm(assets, { recursive: true, force: true });
await mkdir(assets, { recursive: true });
const result = await build({ entryPoints: [resolve(root, 'src/app.js')], outdir: assets, bundle: true,
  format: 'iife', splitting: false, target: 'es2022', minify: true,
  chunkNames: 'chunk-[hash]', assetNames: '[name]-[hash]',
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' }, legalComments: 'eof', metafile: true, logLevel: 'info' });
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs).filter(name => name.includes('node_modules/'))) {
  let directory = dirname(resolve(root, input));
  while (directory !== root && directory.startsWith(root)) {
    try {
      const file = join(directory, 'package.json');
      await access(file);
      const info = JSON.parse(await readFile(file, 'utf8'));
      if (!info.name || !info.version) { directory = dirname(directory); continue; }
      packages.set(directory, info);
      break;
    } catch { directory = dirname(directory); }
  }
}
let notices = 'ClearPane bundled third-party components\n\n';
for (const [directory, info] of [...packages.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  notices += `${info.name} ${info.version}\nLicense: ${JSON.stringify(info.license ?? 'See source license')}\n`;
  for (const name of (await readdir(directory)).filter(name => /^(license|licence|copying)([.-].*)?$/i.test(name))) {
    try { notices += await readFile(join(directory, name), 'utf8'); } catch { /* Directories are not license texts. */ }
    notices += '\n';
  }
  notices += '\n';
}
await writeFile(resolve(root, 'plugin/THIRD-PARTY-NOTICES.txt'), notices);

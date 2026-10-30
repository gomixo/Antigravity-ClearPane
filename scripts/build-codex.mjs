import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, access, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(root, 'dist/codex-clearpane');
if (relative(root, destination).startsWith('..')) throw new Error('Package path escaped workspace');
await rm(destination, { recursive: true, force: true });
await mkdir(join(destination, 'web/assets'), { recursive: true });
const browser = await build({ entryPoints: [join(root, 'src/codex-entry.mjs')],
  outdir: join(destination, 'web/assets'), entryNames: 'app', bundle: true, format: 'iife',
  target: 'es2022', minify: true, metafile: true, legalComments: 'eof',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
const backend = await build({ entryPoints: [join(root, 'codex/server.mjs'), join(root, 'codex/start.mjs')],
  outdir: destination, bundle: true, platform: 'node', format: 'esm', target: 'node22',
  metafile: true, legalComments: 'eof', outExtension: { '.js': '.mjs' },
  banner: { js: "import { createRequire as clearpaneCreateRequire } from 'node:module'; const require = clearpaneCreateRequire(import.meta.url);" } });

let html = await readFile(join(root, 'plugin/sidecars/panel/index.html'), 'utf8');
html = html.replace(/<script src="\/preload\.js"><\/script>/, '')
  .replace(/\?v=[^"\s]+/g, '')
  .replace('<div id="header-content">', '<p id="host-target" class="muted" aria-label="阅读会话"></p><div id="header-content">')
  .replace('<button id="resume-comment"', '<button id="native-annotation" type="button" hidden disabled>宿主批注</button><button id="resume-comment"')
  .replace('<p id="batch-size"', '<p id="delivery-help" class="muted"></p><p id="batch-size"')
  .replace('<button id="send-batch"', '<button id="copy-batch" type="button" disabled>复制整批评论</button><button id="send-batch"')
  .replace('累计后统一发送到主会话。', '累计后在待发送清单中统一提交。')
  .replace('</body>', '<dialog id="export-dialog" aria-labelledby="export-title"><h2 id="export-title">复制整批评论</h2><p>按 Ctrl+C（macOS：⌘C）复制，粘贴到目标 Codex 会话后发送。评论已保留。</p><label for="export-text">评论内容</label><textarea id="export-text" readonly rows="12"></textarea><button id="close-export" type="button">关闭</button></dialog></body>');
const styles = await readFile(join(root, 'plugin/sidecars/panel/styles.css'), 'utf8') + '\n' +
  '#host-target{margin:0;padding:0 20px 8px;overflow-wrap:anywhere;font-size:12px}\n' +
  '#export-dialog{width:min(90vw,700px);max-height:90dvh;overflow:auto}#export-text{box-sizing:border-box;width:100%}\n' +
  '.batch-actions{flex-wrap:wrap}#delivery-help{overflow-wrap:anywhere}\n';
await writeFile(join(destination, 'web/index.html'), html);
await writeFile(join(destination, 'web/styles.css'), styles);
const css = await readFile(join(destination, 'web/assets/app.css'), 'utf8');
const js = await readFile(join(destination, 'web/assets/app.js'), 'utf8');
const inline = html.replace(/<link rel="stylesheet" href="\/assets\/app.css">/, () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)
  .replace(/<link rel="stylesheet" href="\/styles.css">/, () => `<style>${styles}</style>`)
  .replace(/<script defer src="\/assets\/app.js"><\/script>/, '')
  .replace('</body>', () => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script></body>`);
await writeFile(join(destination, 'web/mcp.html'), inline);
// Source entrypoints use the same generated UI as the standalone distribution.
await mkdir(join(root, 'codex/web'), { recursive: true });
await cp(join(destination, 'web'), join(root, 'codex/web'), { recursive: true });
for (const name of ['plugin.json', 'mcp.json', 'skills']) {
  await cp(join(root, 'codex', name), join(destination, name), { recursive: true });
}
await cp(join(root, 'plugin/assets'), join(destination, 'assets'), { recursive: true });
await cp(join(root, 'docs/Codex使用说明.md'), join(destination, 'README.md'));
await cp(join(root, 'docs/Codex版本可行性研究.md'), join(destination, 'Codex版本可行性研究.md'));

// Include licenses for every bundled browser and server dependency.
const packages = new Map();
for (const input of [...Object.keys(browser.metafile.inputs), ...Object.keys(backend.metafile.inputs)]) {
  if (!input.includes('node_modules/')) continue;
  let directory = dirname(resolve(root, input));
  while (directory !== root && directory.startsWith(root)) {
    try {
      await access(join(directory, 'package.json'));
      const info = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (!info.name || !info.version) { directory = dirname(directory); continue; }
      packages.set(directory, info); break;
    } catch { directory = dirname(directory); }
  }
}
let notices = 'ClearPane bundled third-party components\n\n';
for (const [directory, info] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  notices += `${info.name} ${info.version}\nLicense: ${JSON.stringify(info.license ?? 'See source license')}\n`;
  for (const name of (await readdir(directory)).filter(name => /^(license|licence|copying)([.-].*)?$/i.test(name))) {
    try { notices += await readFile(join(directory, name), 'utf8'); } catch { /* Not a text file. */ }
    notices += '\n';
  }
  notices += '\n';
}
await writeFile(join(destination, 'THIRD-PARTY-NOTICES.txt'), notices);
console.log(`Codex 离线插件目录：${destination}`);

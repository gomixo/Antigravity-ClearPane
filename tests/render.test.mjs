import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/render.mjs';

test('frontmatter is collapsed, escaped verbatim and separate from rendered body', () => {
  const metadata = 'title: 财经UP主报告\nsource: CLS同学\ndate: \'2026-10-22\'\ntopics:\n  - 宏观回测\n  - 预测准确率\nnote: <script>alert(1)</script> & $x$ [链接](https://example.com)\ndiagram: |\n  ```mermaid\n  flowchart LR\n  A --> B\n  ```\n';
  for (const newline of ['\n', '\r\n']) {
    for (const bom of ['', '\uFEFF']) {
      for (const end of ['---', '...']) {
        const input = `${bom}---\n${metadata}${end}\n\n# 报告\n\n正文 $x^2$\n\n---\n\n结尾`;
        const { html, diagrams } = renderMarkdown(input.replaceAll('\n', newline));
        assert.match(html, /^<details class="frontmatter" data-no-comment><summary>文档属性<\/summary><pre><code>/);
        const [properties, body] = html.split('</details>');
        assert.doesNotMatch(properties, /\bopen(?:[ =>])|<script>|<a |generated-math|data-diagram|<li>/);
        assert.match(properties, /topics:\r?\n  - 宏观回测\r?\n  - 预测准确率/);
        assert.match(properties, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; \$x\$/);
        assert.doesNotMatch(body, /title:|source:|topics:/);
        assert.match(body, /<h1>报告<\/h1>/);
        assert.match(body, /generated-math/);
        assert.equal((body.match(/<hr>/g) ?? []).length, 1);
        assert.deepEqual(diagrams, []);
      }
    }
  }
  assert.match(renderMarkdown('---\ntitle: 属性文件\n---').html, /<\/details>\n$/);
  assert.match(renderMarkdown('---\ntitle:\n---\n# 正文').html, /class="frontmatter"/);
  assert.match(renderMarkdown('---\n标题: 报告\n---').html, /class="frontmatter"/);
});

test('unclosed blocks, ordinary rules and YAML examples remain Markdown', () => {
  for (const text of [
    '---\ntitle: 未闭合\n\n# 正文',
    '---\n普通段落\n\n---\n\n# 正文',
    '---\n# title: 注释\n---\n\n# 正文',
    '---\n---\n\ntitle: 正文\n\n---',
    '# 正文\n\n---\ntitle: 后续字段\n---',
    '```yaml\n---\ntitle: 示例\n---\n```',
    '    ---\n    title: 缩进代码\n    ---',
  ]) {
    const { html } = renderMarkdown(text);
    assert.doesNotMatch(html, /class="frontmatter"/, text);
    assert.match(html, /正文|普通段落|示例|缩进代码/, text);
  }
});

test('HTML and unsafe links stay inert; task checkboxes are disabled', () => {
  const { html } = renderMarkdown('<script>globalThis.hacked=true</script>\n\n<img src=x onerror=alert(1)>\n\n![remote](https://example.com/a.png)\n\n[bad](javascript:alert(1))\n\n[local](../secret.md)\n\n[web](https://example.com)\n\n- [x] done');
  assert.ok(!html.includes('<script>'));
  assert.equal((html.match(/<img /g) ?? []).length, 1);
  assert.match(html, /data-image-src="https:\/\/example.com\/a.png"/);
  assert.ok(!html.includes('href='));
  assert.match(html, /data-copy-url="https:\/\/example\.com"/);
  assert.ok(!html.includes('data-copy-url="javascript:'));
  assert.match(html, /disabled="disabled"/);
});

test('local, remote and reference images render without enabling other URL schemes', () => {
  const sources = ['./images/中文%20图.png', '../a.png', 'D:/images/a.png', String.raw`D:\images\a.png`,
    'file:///D:/images/a.png', 'http://example.com/a.png?q=1&x=2', 'https://example.com/a.png'];
  for (const src of sources) {
    const { html } = renderMarkdown(`![说明](<${src}> "标题")`);
    assert.match(html, /<img data-image-src=/, src);
    assert.match(html, /alt="说明" title="标题" referrerpolicy="no-referrer"/);
    assert.doesNotMatch(html, /<img src=/);
  }
  for (const src of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'blob:evil', '//server/a.png', 'ftp://server/a.png']) {
    assert.doesNotMatch(renderMarkdown(`![bad](<${src}>)`).html, /<img /);
  }
  assert.match(renderMarkdown('![ref][image]\n\n[image]: ./a.png').html, /data-image-src=".\/a.png"/);
  assert.doesNotMatch(renderMarkdown('[ref][image]\n\n[image]: ./a.png').html, /data-copy-url/);
  assert.doesNotMatch(renderMarkdown('[local](file:///D:/a.png)').html, /data-copy-url/);
  assert.match(renderMarkdown('[![image](./a.png)](https://example.com)').html, /data-image-src=".\/a.png"/);
  assert.doesNotMatch(renderMarkdown('![x](<./a.png> "\" onerror=bad")').html, /<img[^>]+ onerror=/);
});
test('tables, explicit code highlighting, math and diagrams render; invalid formula stays local', () => {
  const { html, diagrams } = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst value = 2;\n```\n\n```unknown\n<script>\n```\n\n$x^2$\n\n$$\n\\frac{1}{2}\n$$\n\n$\\badcommand$\n\n```mermaid\nflowchart LR\nA --> B\n```\n\n正文结尾');
  assert.match(html, /table-scroll/);
  assert.match(html, /hljs-keyword/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /class="generated-math" data-no-comment/);
  assert.match(html, /katex/);
  assert.match(html, /公式无法渲染/);
  assert.match(html, /正文结尾/);
  assert.match(html, /data-diagram="0"/);
  assert.equal(diagrams.length, 1);
});

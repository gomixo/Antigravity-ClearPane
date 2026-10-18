import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewSession } from '../src/session.mjs';
import { SessionCache } from '../plugin/sidecars/panel/sessions.mjs';

test('conversation snapshots survive recreation, isolate conversations, pause reads and lock in-flight sends', async () => {
  const cache = new SessionCache();
  const a = new PreviewSession();
  const document = { path: 'D:\\example.md', name: 'example.md', text: '# latest', checkedAt: '2026-10-13T00:00:00Z' };
  a.success(a.begin(document.path), document);
  for (const quote of ['first', 'second']) { a.selectQuote(quote, 'A'); a.addComment('A', true, 'comment ' + quote); }
  a.selectQuote('draft quote', 'A');
  const stale = a.begin(a.path);
  assert.equal(a.pauseRead(), true);
  assert.equal(a.success(stale, { ...document, text: 'late' }), null);
  assert.equal(a.draft.valid, true);
  const state = a.snapshot('unfinished', 'execute', 240);
  assert.deepEqual(cache.write('A', 0, state), { version: 1 });
  state.comments[0].comment = 'mutated externally';
  assert.deepEqual(cache.read('B'), { version: 0, state: null });
  const restored = new PreviewSession();
  const saved = cache.read('A');
  restored.restore(saved.state);
  assert.equal(restored.document.text, '# latest');
  assert.deepEqual(restored.comments.map(item => item.comment), ['comment first', 'comment second']);
  assert.equal(saved.state.commentText, 'unfinished');
  assert.equal(saved.state.instruction, 'execute');
  assert.equal(saved.state.scrollTop, 240);
  assert.equal(restored.canSend('A', true, saved.state.commentText), true);
  cache.write('open-draft', 0, { ...new PreviewSession().snapshot(), commentOpen: true });
  assert.equal(cache.read('open-draft').state.commentOpen, true);
  assert.match(restored.batchError('B', true), /目标会话/);
  assert.match(restored.batchError('A', false), /不可见/);
  const readCopy = cache.read('A');
  readCopy.state.document.text = 'changed';
  assert.equal(cache.read('A').state.document.text, '# latest');
  assert.throws(() => cache.write('A', 0, saved.state), /其他面板/);

  let receipt;
  const pending = restored.sendBatch(() => new Promise(resolve => { receipt = resolve; }), 'A', true, 'execute');
  cache.write('A', 1, restored.snapshot('unfinished', 'execute', 240));
  const recreated = new PreviewSession();
  recreated.restore(cache.read('A').state);
  assert.equal(recreated.sending, false);
  assert.equal(recreated.uncertain, true);
  await assert.rejects(recreated.sendBatch(() => { throw new Error('must not send'); }, 'A', true), /未确认/);
  const b = new PreviewSession();
  b.success(b.begin(document.path), { ...document, text: 'B content' });
  cache.write('B', 0, b.snapshot());
  receipt({});
  assert.equal(await pending, 'sent');
  cache.write('A', 2, restored.snapshot('unfinished', '', 240));
  assert.equal(cache.read('A').state.comments.length, 0);
  assert.equal(cache.read('B').state.document.text, 'B content');
  assert.equal(new SessionCache().read('A').state, null);
});

test('cache validates trust boundary and strips extra fields without changing the previous snapshot', () => {
  const cache = new SessionCache();
  const model = new PreviewSession();
  const state = model.snapshot();
  cache.write('A', 0, { ...state, html: '<script>bad</script>' });
  assert.equal('html' in cache.read('A').state, false);
  for (const invalid of [null, { ...state, comments: {} }, { ...state, scrollTop: -1 },
    { ...state, commentText: 'x'.repeat(4001) }, { ...state, instruction: 'x'.repeat(4001) },
    { ...state, sending: 'true' }, { ...state, commentOpen: 'true' }, { ...state, path: '\0' },
    { ...state, draft: { path: '', quote: '', revision: 0, conversationId: 'B', valid: true } },
    { ...state, document: { path: '', name: '', checkedAt: '', text: '中'.repeat(400000) } }]) {
    assert.throws(() => cache.write('A', 1, invalid));
    assert.equal(cache.read('A').version, 1);
  }
  for (const id of ['', null, '__proto__'.repeat(100)]) assert.throws(() => cache.read(id));
  assert.throws(() => cache.write('A', NaN, state));
});

test('selection anchors survive drafts, comments and cache validation without accepting invalid or extra fields', () => {
  const model = new PreviewSession();
  const document = { path: 'D:/anchor.md', name: 'anchor.md', text: 'repeat repeat', checkedAt: '' };
  model.success(model.begin(document.path), document);
  const anchor = { start: { path: [2, 0], offset: 7 }, end: { path: [2, 0], offset: 13 } };
  model.selectQuote('repeat', 'A', anchor);
  anchor.start.offset = 0;
  assert.equal(model.draft.anchor.start.offset, 7);
  const cache = new SessionCache();
  cache.write('A', 0, model.snapshot('draft'));
  model.restore(cache.read('A').state);
  model.addComment('A', true, 'edit second occurrence');
  model.comments[0].anchor.extra = '<script>';
  cache.write('A', 1, model.snapshot());
  const saved = cache.read('A').state;
  assert.deepEqual(saved.comments[0].anchor, { start: { path: [2, 0], offset: 7 }, end: { path: [2, 0], offset: 13 } });
  for (const invalid of [null, {}, { start: { path: [-1], offset: 0 }, end: anchor.end },
    { start: { path: [0], offset: 0.5 }, end: anchor.end },
    { start: { path: Array(129).fill(0), offset: 0 }, end: anchor.end }]) {
    assert.throws(() => cache.write('A', 2, { ...saved, comments: [{ ...saved.comments[0], anchor: invalid }] }));
    assert.equal(cache.read('A').version, 2);
  }
  model.success(model.begin(model.path), document);
  assert.equal(model.comments[0].revision, model.revision);
  model.success(model.begin(model.path), { ...document, text: 'changed' });
  assert.notEqual(model.comments[0].revision, model.revision);
});

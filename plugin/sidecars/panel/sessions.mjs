import { MAX_BYTES } from './files.mjs';

const string = (value, limit) => typeof value === 'string' && value.length <= limit;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const path = value => string(value, 32768) && !value.includes('\0');
const point = value => value && Array.isArray(value.path) && value.path.length <= 128 &&
  value.path.every(integer) && integer(value.offset);
const anchor = value => value === undefined || (value && point(value.start) && point(value.end));

export function validateSnapshot(state, conversationId) {
  const quote = item => item && path(item.path) && string(item.quote, 8000) && integer(item.revision) &&
    item.conversationId === conversationId && typeof item.valid === 'boolean' && anchor(item.anchor);
  if (!state || !path(state.path) || !integer(state.revision) ||
    ![state.sending, state.uncertain].every(value => typeof value === 'boolean') ||
    !(state.commentOpen === undefined || typeof state.commentOpen === 'boolean') ||
    !(state.error === null || string(state.error, 4000)) ||
    !(state.document === null || (path(state.document.path) && state.document.path === state.path &&
      string(state.document.name, 32768) && string(state.document.checkedAt, 100) &&
      string(state.document.text, MAX_BYTES) && Buffer.byteLength(state.document.text, 'utf8') <= MAX_BYTES)) ||
    !(state.draft === null || quote(state.draft)) || !Array.isArray(state.comments) ||
    !state.comments.every(item => quote(item) && item.path.toLowerCase() === state.path.toLowerCase() &&
      string(item.comment, 4000) && typeof item.sourceChanged === 'boolean') ||
    !string(state.commentText, 4000) || !string(state.instruction, 4000) ||
    !Number.isFinite(state.scrollTop) || state.scrollTop < 0) throw new Error('无效的会话状态。');
  // Keep only the cache contract, never arbitrary client fields or rendered HTML.
  const copyQuote = item => ({ path: item.path, quote: item.quote, revision: item.revision,
    conversationId, valid: item.valid, ...(item.anchor === undefined ? {} : { anchor: {
      start: { path: [...item.anchor.start.path], offset: item.anchor.start.offset },
      end: { path: [...item.anchor.end.path], offset: item.anchor.end.offset },
    } }) });
  return { path: state.path, revision: state.revision, error: state.error,
    document: state.document && { path: state.document.path, name: state.document.name,
      text: state.document.text, checkedAt: state.document.checkedAt },
    draft: state.draft && copyQuote(state.draft),
    comments: state.comments.map(item => ({ ...copyQuote(item), comment: item.comment, sourceChanged: item.sourceChanged })),
    sending: state.sending, uncertain: state.uncertain, commentText: state.commentText,
    instruction: state.instruction, scrollTop: state.scrollTop,
    ...(state.commentOpen === undefined ? {} : { commentOpen: state.commentOpen }) };
}

export class SessionCache {
  // ponytail: process memory only; disk persistence belongs to a separate restart-recovery feature.
  sessions = new Map();
  read(conversationId) {
    if (!string(conversationId, 256) || !conversationId.trim()) throw new Error('缺少目标会话。');
    return structuredClone(this.sessions.get(conversationId) ?? { version: 0, state: null });
  }
  write(conversationId, version, state) {
    const previous = this.read(conversationId);
    if (!integer(version)) throw new Error('无效的状态版本。');
    if (version !== previous.version) {
      const error = new Error('会话状态已在其他面板更新，请重新打开面板恢复。当前内容仍保留。');
      error.code = 'STATE_CONFLICT';
      throw error;
    }
    const next = { version: version + 1, state: validateSnapshot(state, conversationId) };
    this.sessions.set(conversationId, next);
    return { version: next.version };
  }
}

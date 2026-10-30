export const QUOTE_LIMIT = 8000;
export const COMMENT_LIMIT = 4000;
export const MESSAGE_LIMIT = 14000;
const key = path => path.toLowerCase();

export class PreviewSession {
  path = '';
  document = null;
  session = 0;
  request = 0;
  revision = 0;
  loading = false;
  error = null;
  draft = null;
  comments = [];
  sending = false;
  uncertain = false;

  snapshot(commentText = '', instruction = '', scrollTop = 0) {
    return structuredClone({ path: this.path, document: this.document, revision: this.revision,
      error: this.error, draft: this.draft, comments: this.comments, sending: this.sending,
      uncertain: this.uncertain, commentText, instruction, scrollTop });
  }
  restore(state) {
    this.reset();
    if (!state) return;
    for (const field of ['path', 'document', 'revision', 'error', 'draft', 'comments']) this[field] = structuredClone(state[field]);
    this.uncertain = state.uncertain || state.sending;
  }
  pauseRead() {
    if (!this.loading) return false;
    this.request++;
    this.loading = false;
    return true;
  }

  begin(path) {
    if (this.sending) throw new Error('发送期间不能读取文件。');
    if (this.comments.length && key(path) !== key(this.comments[0].path)) throw new Error('请先发送或清空待发送评论，再切换文件。');
    if (key(path) !== key(this.path)) {
      this.path = path;
      this.document = null;
      this.session++;
      this.revision++;
      this.invalidateQuote();
    }
    this.loading = true;
    return { session: this.session, request: ++this.request };
  }
  current(ticket) { return ticket.session === this.session && ticket.request === this.request; }
  success(ticket, document) {
    if (!this.current(ticket)) return null;
    const changed = !this.document || this.document.text !== document.text || key(this.document.path) !== key(document.path);
    if (changed) { this.revision++; this.invalidateQuote(); }
    this.path = document.path;
    this.document = document;
    this.error = null;
    this.loading = false;
    return { changed };
  }
  failure(ticket, message) {
    if (!this.current(ticket)) return false;
    this.error = message;
    this.loading = false;
    this.invalidateQuote();
    return true;
  }
  invalidateQuote() {
    if (this.draft) this.draft.valid = false;
    for (const item of this.comments) item.sourceChanged = true;
  }
  selectQuote(quote, conversationId, anchor) {
    if (this.sending || this.uncertain) throw new Error('请先确认当前发送结果。');
    if (!this.document || this.loading || this.error || !conversationId) throw new Error('请先打开有效文件并进入目标会话。');
    if (!quote.trim() || quote.length > QUOTE_LIMIT) throw new Error('引用不能为空或超过 8,000 字符。');
    this.draft = { quote, path: this.document.path, revision: this.revision, conversationId, valid: true };
    if (anchor) this.draft.anchor = structuredClone(anchor);
  }
  canSend(conversationId, visible, comment) {
    const d = this.draft;
    return !!(visible && !this.loading && !this.error && d?.valid && d.revision === this.revision &&
      d.path === this.document?.path && d.conversationId === conversationId && comment.trim() && comment.length <= COMMENT_LIMIT);
  }
  addComment(conversationId, visible, comment) {
    if (this.sending || this.uncertain || !this.canSend(conversationId, visible, comment)) throw new Error('请检查引用、评论和目标会话。');
    if (this.comments.length && this.comments[0].conversationId !== conversationId) throw new Error('目标会话已变化，请清空原批评论。');
    this.comments.push({ ...this.draft, comment: comment.trim(), sourceChanged: false });
    this.draft = null;
  }
  updateComment(index, comment) {
    if (this.sending || this.uncertain || !this.comments[index] || typeof comment !== 'string') throw new Error('当前不能编辑评论。');
    this.comments[index].comment = comment;
  }
  removeComment(index) {
    if (this.sending || this.uncertain) throw new Error('当前不能删除评论。');
    if (Number.isInteger(index) && index >= 0) this.comments.splice(index, 1);
  }
  clearComments() {
    if (this.sending || this.uncertain) throw new Error('请先确认发送结果。');
    this.comments = [];
  }
  batchError(conversationId, visible, instruction = '') {
    if (!visible) return '面板不可见，不能发送。';
    if (this.sending) return '正在发送，请稍候。';
    if (this.uncertain) return '发送结果未确认，请检查主会话后解锁重试。';
    if (!this.comments.length) return '请先加入评论。';
    if (!conversationId || this.comments.some(item => item.conversationId !== conversationId)) return '目标会话已变化，不能发送原批评论。';
    if (this.loading) return '请等待文件读取完成。';
    if (this.comments.some(item => key(item.path) !== key(this.path))) return '待发送评论必须来自当前文件。';
    if (instruction.length > COMMENT_LIMIT) return '统一指令超过 4,000 字符。';
    if (this.comments.some(item => !item.comment.trim() || item.comment.length > COMMENT_LIMIT)) return '每条评论须为 1–4,000 字符。';
    const message = batchMessage(this.comments, instruction);
    // ponytail: SDK uses Windows command-line arguments; split the batch if it exceeds this ceiling.
    if (message.length > MESSAGE_LIMIT) return '整批消息过长，请缩小本批内容，分批发送。';
    return '';
  }
  async sendBatch(send, conversationId, visible, instruction = '', timeout = 15000) {
    const error = this.batchError(conversationId, visible, instruction);
    if (error) throw new Error(error);
    const comments = this.comments;
    const session = this.session;
    const message = batchMessage(comments, instruction);
    this.sending = true;
    let timer;
    try {
      const receipt = await Promise.race([
        send(message, conversationId),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Unknown send result')), timeout); }),
      ]);
      if (receipt?.error || receipt?.isError || receipt?.response?.error) return 'rejected';
      if (this.session === session && this.comments === comments) this.comments = [];
      return 'sent';
    } catch {
      if (this.session === session && this.comments === comments) this.uncertain = true;
      return 'uncertain';
    } finally {
      clearTimeout(timer);
      if (this.session === session) this.sending = false;
    }
  }
  reset() {
    this.session++;
    this.request++;
    this.revision++;
    this.path = '';
    this.document = null;
    this.draft = null;
    this.comments = [];
    this.sending = false;
    this.uncertain = false;
    this.loading = false;
    this.error = null;
  }
}

export function commentMessage(draft, comment) {
  return `ClearPane 选区评论\n\n文件：${draft.path}\n\n引用：\n${draft.quote.split(/\r?\n/).map(line => `> ${line}`).join('\n')}\n\n评论：\n${comment.trim()}`;
}

export function batchMessage(comments, instruction = '') {
  return `ClearPane 批量评论（${comments.length} 条）${instruction.trim() ? `\n\n统一指令：\n${instruction.trim()}` : ''}\n\n` +
    comments.map((item, index) => `评论 ${index + 1}${item.sourceChanged ? '（来源已变化，以下为加入时的引用快照）' : ''}\n${commentMessage(item, item.comment)}`).join('\n\n---\n\n');
}

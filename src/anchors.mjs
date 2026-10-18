export function saveRange(root, range) {
  const point = (node, offset) => {
    const path = [];
    while (node !== root) {
      if (!node?.parentNode) throw new Error('选区不在正文内。');
      path.unshift([...node.parentNode.childNodes].indexOf(node));
      node = node.parentNode;
    }
    return { path, offset };
  };
  return { start: point(range.startContainer, range.startOffset), end: point(range.endContainer, range.endOffset) };
}

export function restoreRange(root, anchor) {
  if (!anchor) return null;
  const nodeAt = point => point.path.reduce((node, index) => node?.childNodes[index], root);
  try {
    const start = nodeAt(anchor.start), end = nodeAt(anchor.end);
    if (!start || !end) return null;
    const range = root.ownerDocument.createRange();
    range.setStart(start, anchor.start.offset);
    range.setEnd(end, anchor.end.offset);
    if (range.collapsed || !range.toString().trim() ||
      [...root.querySelectorAll('[data-no-comment]')].some(node => range.intersectsNode(node))) return null;
    return range;
  } catch { return null; }
}

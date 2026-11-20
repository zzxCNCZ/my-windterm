export const defaultContextLines = 120;
const maxContextLength = 16_000;

function clean(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

function limit(text, recent = false) {
  const content = recent ? text.trimEnd() : text;
  const truncated = content.length > maxContextLength;
  const clipped = truncated
    ? (recent
      ? content.slice(-maxContextLength).replace(/^[\uDC00-\uDFFF]/, '')
      : content.slice(0, maxContextLength).replace(/[\uD800-\uDBFF]$/, ''))
    : content;
  return clipped.trim() ? { text: clipped, truncated } : null;
}

export function selectedContext(terminal) {
  return limit(clean(terminal.getSelection()));
}

export function recentContext(terminal, maxLines = defaultContextLines) {
  const buffer = terminal.buffer.active;
  let end = buffer.length;
  while (end > 0 && !buffer.getLine(end - 1)?.translateToString(true).trim()) end--;
  const start = Math.max(0, end - maxLines);
  const parts = [];
  for (let index = start; index < end; index++) {
    const line = buffer.getLine(index);
    if (!line) continue;
    if (index > start && !line.isWrapped) parts.push('\n');
    const continues = index + 1 < end && buffer.getLine(index + 1)?.isWrapped;
    parts.push(line.translateToString(!continues));
  }
  return limit(clean(parts.join('')), true);
}

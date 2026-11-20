import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, breaks: true });

markdown.validateLink = value => {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
};

// A link opens in the system browser only when clicked. Images render their alt text.
markdown.renderer.rules.link_open = (tokens, index) => {
  const url = markdown.utils.escapeHtml(tokens[index].attrGet('href') ?? '');
  return `<button type="button" class="ai-markdown-link" data-ai-url="${url}">`;
};
markdown.renderer.rules.link_close = () => '</button>';
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);

export function renderAiMarkdown(source) {
  return markdown.render(source);
}

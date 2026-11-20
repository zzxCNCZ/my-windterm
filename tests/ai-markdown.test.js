import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderAiMarkdown } from '../src/ai-markdown.js';

test('renders Markdown headings, lists, tables, code and clickable web links', () => {
  const html = renderAiMarkdown([
    '## Diagnosis', '', '- **First**', '',
    '| key | value |', '| --- | --- |', '| disk | 100% |', '',
    '`df -h`', '', '[Guide](https://example.test/docs?a=1&b=2)', '',
    '```sh', 'echo "<ok>"', '```',
  ].join('\n'));
  for (const token of ['<h2>Diagnosis</h2>', '<li><strong>First</strong></li>', '<table>', '<code>df -h</code>',
    'data-ai-url="https://example.test/docs?a=1&amp;b=2"', '<code class="language-sh">echo &quot;&lt;ok&gt;&quot;']) {
    assert.ok(html.includes(token), token);
  }
});

test('escapes raw HTML and rejects non-web or credential-bearing links', () => {
  const html = renderAiMarkdown([
    '<img src=x onerror=alert(1)>', '',
    '[bad](javascript:alert%281%29) [local](file:///tmp/a) [creds](https://user:pass@example.test)', '',
    '![sample](https://example.test/image.png)',
  ].join('\n'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('sample'));
  assert.ok(!/<(?:img|script|a|button)\b/.test(html));
});

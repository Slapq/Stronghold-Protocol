// docs/context/DOC-INDEX.md (tools/doc-index.mjs): the table of contents of the long docs stays current, so the line
// numbers agents and people jump to are right.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, headings } from '../tools/doc-index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('headings: levels and 1-based lines, nothing inside fenced code', () => {
  const text = '# A\ntext\n## B ##\n```js\n# not a heading\n```\n### C\n##### too deep\n';
  assert.deepEqual(headings(text), [{ level: 1, title: 'A', line: 1 }, { level: 2, title: 'B', line: 3 }, { level: 3, title: 'C', line: 7 }]);
});

test('the committed doc index is current (run `node tools/doc-index.mjs` after editing a doc)', () => {
  const docs = readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).sort()
    .map((f) => ({ name: f, text: readFileSync(path.join(ROOT, 'docs', f), 'utf8') }));
  assert.equal(readFileSync(path.join(ROOT, 'docs/context/DOC-INDEX.md'), 'utf8'), buildIndex(docs));
});

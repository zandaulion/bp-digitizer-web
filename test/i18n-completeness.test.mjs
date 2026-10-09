import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readdir} from 'node:fs/promises';

const directory = new URL('../web/i18n/', import.meta.url);

function placeholders(value) {
  const strings = typeof value === 'string' ? [value] : Object.values(value || {});
  return [...new Set(strings.flatMap((text) => text.match(/\{\d+\}/g) || []))].sort();
}

test('every locale contains the complete catalogue with matching placeholders', async () => {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  const catalogues = Object.fromEntries(await Promise.all(files.map(async (name) => [
    name.slice(0, -5), JSON.parse(await readFile(new URL(name, directory), 'utf8')),
  ])));
  const english = catalogues.en;
  const expectedKeys = Object.keys(english).sort();

  for (const [locale, catalogue] of Object.entries(catalogues)) {
    assert.deepEqual(Object.keys(catalogue).sort(), expectedKeys, `${locale} catalogue keys`);
    for (const key of expectedKeys) {
      assert.equal(typeof catalogue[key], typeof english[key], `${locale}.${key} value type`);
      assert.deepEqual(placeholders(catalogue[key]), placeholders(english[key]),
        `${locale}.${key} placeholders`);
    }
  }
});

test('runtime UI does not retain known hard-coded English fallbacks', async () => {
  const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /textContent\s*=\s*['"]checking…['"]/);
  assert.doesNotMatch(html, /aria-label="Back"/);
  assert.doesNotMatch(html, />mmHg<|>bpm</);
});

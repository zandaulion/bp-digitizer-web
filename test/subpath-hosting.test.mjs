import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const web = new URL('../web/', import.meta.url);
const read = (name) => readFile(new URL(name, web), 'utf8');

test('browser entry points do not escape a project-site base path', async () => {
  const [html, app, i18n, updater, worker, bust] = await Promise.all([
    read('index.html'), read('app.js'), read('i18n.js'), read('pwa-update.js'),
    read('sw.js'), read('bust.html'),
  ]);

  assert.doesNotMatch(html, /\b(?:href|src)="\//, 'HTML asset URL');
  assert.doesNotMatch(app, /from\s+['"]\//, 'module import');
  assert.match(app, /new URL\('\.\/hearth\/inference-worker\.js', import\.meta\.url\)/);
  assert.doesNotMatch(i18n, /fetch\(\s*[`'"]\//, 'locale fetch');
  assert.match(updater, /new URL\('\.\/sw\.js', import\.meta\.url\)/);
  assert.doesNotMatch(worker, /['"]\/(?:index|app|db|bp|i18n|hearth|icons)/,
    'service-worker asset URL');
  assert.match(bust, /location\.replace\('\.\/'\)/);
});

test('manifest URLs resolve inside the GitHub Pages project path', async () => {
  const manifest = JSON.parse(await read('manifest.webmanifest'));
  const site = new URL('https://example.github.io/example-project/');
  const manifestUrl = new URL('manifest.webmanifest', site);

  for (const value of [manifest.id, manifest.start_url, manifest.scope]) {
    assert.equal(new URL(value, manifestUrl).href, site.href);
  }
  for (const icon of manifest.icons) {
    assert.ok(new URL(icon.src, manifestUrl).href.startsWith(site.href));
  }
  for (const shortcut of manifest.shortcuts) {
    assert.ok(new URL(shortcut.url, manifestUrl).href.startsWith(site.href));
    for (const icon of shortcut.icons || []) {
      assert.ok(new URL(icon.src, manifestUrl).href.startsWith(site.href));
    }
  }
});

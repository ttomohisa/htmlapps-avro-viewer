const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const slug = JSON.parse(fs.readFileSync(path.join(root, 'app.config.json'), 'utf8')).slug;
const targets = process.argv.slice(2);
if (!targets.length) targets.push('src/index.template.html', `${slug}.html`, 'dist/index.html', 'dist/index.self-extract.html');
for (const target of targets) {
  let html = fs.readFileSync(path.resolve(root, target), 'utf8');
  const payload = html.match(/<script id="self-extract-payload"[^>]*>([\s\S]*?)<\/script>/);
  if (payload) html = gunzipSync(Buffer.from(payload[1].replace(/\s/g, ''), 'base64')).toString('utf8');
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const rules = selector => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1].trim() === selector).map(match => match[2]);
  const has = (selector, pattern) => rules(selector).some(rule => pattern.test(rule));
  // Removing flex ownership or the body's shrink permission recreates the
  // native 320x252 overflow: body bottom 268 while sheet ends at 252.
  test(`${target}: dialog body owns the remaining bounded viewport height`, () => {
    assert(has('dialog', /max-height\s*:[^;]*100dvh/), 'explicit dynamic viewport ceiling');
    assert(has('dialog', /overflow\s*:\s*hidden\s*;/), 'dialog itself must not add a second scrollport');
    assert(has('dialog[open]', /display\s*:\s*flex\s*;/));
    assert(has('dialog[open]', /flex-direction\s*:\s*column\s*;/));
    assert(has('.dialog-header', /flex\s*:\s*0 0 auto\s*;/), 'header stays visible');
    assert(has('.dialog-body', /min-height\s*:\s*0\s*;/), 'body may shrink below content size');
    assert(has('.dialog-body', /flex\s*:\s*1 1 auto\s*;/));
    assert(has('.dialog-body', /max-height\s*:\s*none\s*;/), 'body uses available space, not unrelated viewport subtraction');
    assert(has('.dialog-body', /overflow\s*:\s*auto\s*;/));
  });
  test(`${target}: open modal contains scroll and preserves narrow bottom sheet`, () => {
    assert(has('html:has(dialog[open])', /overflow\s*:\s*hidden\s*;/), 'background cannot scroll while modal is open');
    assert(has('.dialog-body', /overscroll-behavior\s*:\s*contain\s*;/));
    assert(has('dialog', /margin\s*:\s*auto 0 0\s*;/));
    assert(has('dialog', /max-height\s*:\s*calc\(100dvh - 10px - env\(safe-area-inset-top\)\)/));
    assert(has('.dialog-body', /padding-bottom\s*:\s*calc\(22px \+ env\(safe-area-inset-bottom\)\)/));
  });
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { gunzipSync } = require('node:zlib');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const targets = process.argv.slice(2);
if (!targets.length) targets.push('src/index.template.html', 'dist/index.html', 'dist/index.self-extract.html', 'avro-viewer.html');

// Run the actual application, including event handlers, with small DOM adapters.
// This checks state/output, not browser layout or native keyboard behavior.
function load(relative) {
  let source = fs.readFileSync(path.resolve(root, relative), 'utf8');
  const payload = source.match(/<script id="self-extract-payload"[^>]*>([\s\S]*?)<\/script>/);
  if (payload) source = gunzipSync(Buffer.from(payload[1].trim(), 'base64')).toString('utf8');
  let created = 0;
  const output = { clipboard: [], storage: [] };
  function element(tag = 'div') {
    created++;
    const listeners = new Map();
    const el = {
      tagName: tag.toUpperCase(), children: [], dataset: {}, style: {}, attributes: {}, className: '', textContent: '', value: '', disabled: false, open: false,
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; this.textContent = ''; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name]; },
      addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
      async dispatch(name) { for (const fn of listeners.get(name) || []) await fn({ target: this, preventDefault() {}, stopPropagation() {} }); },
      async click() { if (!this.disabled) await this.dispatch('click'); },
      contains(node) { return this === node || this.children.some(child => child.contains(node)); },
      querySelectorAll(selector) { return descendants(this).filter(node => matches(node, selector)); },
      showModal() {}, close() {}, getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100 }; }
    };
    el.classList = {
      contains(name) { return el.className.split(/\s+/).includes(name); },
      add(...names) { el.className = [...new Set([...el.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove(...names) { el.className = el.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle(name, force) { const value = force ?? !this.contains(name); value ? this.add(name) : this.remove(name); return value; }
    };
    return el;
  }
  function matches(node, selector) {
    if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
    if (selector === '[data-i18n]') return !!node.dataset.i18n;
    if (selector === '[data-i18n-title]') return !!node.dataset.i18nTitle;
    if (selector === '[data-i18n-aria-label]') return !!node.dataset.i18nAriaLabel;
    if (selector === 'details[data-schema-path]') return node.tagName === 'DETAILS' && node.dataset.schemaPath !== undefined;
    return node.tagName.toLowerCase() === selector;
  }
  const elements = new Map(), staticNodes = [];
  for (const match of source.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const id = match[2].match(/\bid="([^"]+)"/), i18n = match[2].match(/\bdata-i18n="([^"]+)"/);
    if (!id && !i18n) continue;
    const el = element(match[1]);
    if (id) elements.set('#' + id[1], el);
    if (i18n) el.dataset.i18n = i18n[1];
    el.className = match[2].match(/\bclass="([^"]+)"/)?.[1] || '';
    el.disabled = /\bdisabled\b/.test(match[2]);
    staticNodes.push(el);
  }
  const document = {
    body: element('body'), documentElement: element('html'), createElement: element, addEventListener() {},
    querySelector(selector) { assert(elements.has(selector), `Missing DOM target ${selector}`); return elements.get(selector); },
    querySelectorAll(selector) {
      const scoped = selector.match(/^(#[\w-]+) (.+)$/);
      if (scoped) return this.querySelector(scoped[1]).querySelectorAll(scoped[2]);
      return staticNodes.filter(node => matches(node, selector));
    }
  };
  const context = vm.createContext({
    TextDecoder, TextEncoder, Uint8Array, DataView, Blob, Response, DecompressionStream,
    document, window: { addEventListener() {}, scrollTo() {} },
    navigator: { language: 'en', clipboard: { writeText: async text => output.clipboard.push(text) } },
    localStorage: { getItem() { return null; }, setItem(key, value) { output.storage.push([key, value]); } },
    setTimeout() {}, clearTimeout() {}, requestAnimationFrame: fn => fn(),
    __APP_CONFIG_JSON__: { slug: 'avro-viewer', name: 'Avro Viewer', nameJa: 'Avro Viewer', version: '1.0.0' },
    __BUILD_MANIFEST_JSON__: {}, __EMBEDDED_ASSET_BUNDLE_JSON__: {}
  });
  const script = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const end = script.lastIndexOf('    })();');
  assert(end > 0);
  vm.runInContext(script.slice(0, end) + '\n globalThis.api={state,readHeader,scanBlocks,decodeBlock,buildNames,rootFields,buildFileState,renderSchema,renderActive,activateFile,closeFile,inspectFile,addFiles,buildCurrentCsv,t};\n' + script.slice(end), context);
  return { ...context.api, elements, output, source, created: () => created };
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
const nodes = (api, className) => descendants(api.elements.get('#schemaTree')).filter(node => node.classList.contains(className));
const disclosures = api => nodes(api, 'schema-node').filter(node => node.tagName === 'DETAILS');
function long(value) { let n = BigInt(value); n = (n << 1n) ^ (n >> 63n); const out = []; do { const b = Number(n & 127n); n >>= 7n; out.push(b | (n ? 128 : 0)); } while (n); return Buffer.from(out); }
const bytes = value => Buffer.concat([long(value.length), Buffer.from(value)]);
const string = value => bytes(Buffer.from(value, 'utf8'));
function ocf(schema, data = [], schemaText = JSON.stringify(schema), name = 'example.avro') {
  const sync = Buffer.from('0123456789abcdef');
  const metadata = Buffer.concat([long(2), string('avro.schema'), bytes(Buffer.from(schemaText)), string('avro.codec'), bytes(Buffer.from('null')), long(0)]);
  const datum = Buffer.concat(data);
  const container = Buffer.concat([Buffer.from([79, 98, 106, 1]), metadata, sync, ...(data.length ? [long(data.length), long(datum.length), datum, sync] : [])]);
  assert(container.length < 16384, 'fixtures stay small and synthetic');
  const file = new Blob([container]); file.name = name; file.lastModified = 0; return file;
}
async function open(api, schema, data = [], schemaText, name) {
  const file = ocf(schema, data, schemaText, name), current = api.buildFileState(file);
  current.header = await api.readHeader(file); Object.assign(current, await api.scanBlocks(file, current.header));
  current.ctx = { names: api.buildNames(current.header.schema) }; current.fields = api.rootFields(current.header.schema);
  current.rows = current.blocks.length ? (await api.decodeBlock(current, current.blocks[0])).map((value, index) => ({ recordNumber: index + 1, value })) : [];
  current.inspection = 'ready'; api.state.files.push(current); api.state.activeId = current.id; return current;
}
const selfSchema = { type: 'record', name: 'Node', namespace: 'example', fields: [{ name: 'value', type: 'long' }, { name: 'next', type: ['null', 'Node'] }] };
const mutualSchema = { type: 'record', name: 'A', namespace: 'example', fields: [{ name: 'child', type: ['null', { type: 'record', name: 'B', fields: [{ name: 'parent', type: ['null', 'A'] }] }] }] };
const pairSchema = { type: 'record', name: 'Pair', fields: [{ name: 'first', type: { type: 'record', name: 'Child', fields: [{ name: 'value', type: { type: 'int', logicalType: 'date' } }] } }, { name: 'second', type: 'Child' }] };

for (const target of targets) {
  test(`${target}: self-recursive schema has a finite named reference and unchanged data`, async () => {
    const api = load(target), current = await open(api, selfSchema, [Buffer.concat([long(42), long(0)])]);
    assert.doesNotThrow(() => api.renderSchema(current));
    assert(api.created() < 500, 'tree does not expand recursively');
    assert.deepEqual(nodes(api, 'schema-name').map(node => node.textContent), ['Node', 'value', 'next', '[0]', '[1]']);
    assert.equal(nodes(api, 'schema-reference')[0]?.textContent, 'Reference: example.Node');
    assert.equal(api.elements.get('#schemaRaw').textContent, JSON.stringify(selfSchema, null, 2));
    assert.equal(api.buildCurrentCsv(current), '__record,value,next\r\n1,42,null');
  });
  test(`${target}: mutual recursion is bounded without hiding nonrecursive siblings`, async () => {
    const api = load(target), current = await open(api, mutualSchema, [long(0)]);
    assert.doesNotThrow(() => api.renderSchema(current));
    assert(api.created() < 500);
    assert.equal(nodes(api, 'schema-reference')[0]?.textContent, 'Reference: example.A');
    assert.equal(api.elements.get('#schemaRaw').textContent, JSON.stringify(mutualSchema, null, 2));
    assert.equal(api.buildCurrentCsv(current), '__record,child\r\n1,null');
    const pair = await open(api, pairSchema, [Buffer.concat([long(0), long(1)])]);
    api.renderSchema(pair);
    assert.deepEqual(nodes(api, 'schema-name').map(node => node.textContent), ['Pair', 'first', 'value', 'second', 'value']);
    assert.deepEqual(nodes(api, 'schema-logical').map(node => node.textContent), ['date', 'date']);
    assert.equal(nodes(api, 'schema-reference').length, 0);
  });
  test(`${target}: Raw is populated even if tree rendering fails unexpectedly`, async () => {
    const api = load(target), current = await open(api, pairSchema);
    current.ctx.names.get = () => { throw new Error('synthetic tree-only failure'); };
    assert.throws(() => api.renderSchema(current), /synthetic tree-only failure/);
    assert.equal(api.elements.get('#schemaRaw').textContent, JSON.stringify(pairSchema, null, 2));
  });
  test(`${target}: native compound disclosures start expanded with localized controls`, async () => {
    const api = load(target), current = await open(api, pairSchema);
    api.renderActive();
    assert.equal(disclosures(api).length, 3);
    assert(disclosures(api).every(node => node.open && node.children[0].tagName === 'SUMMARY'));
    assert(nodes(api, 'schema-node').filter(node => node.tagName !== 'DETAILS').every(node => !node.children.some(child => child.tagName === 'SUMMARY')));
    assert.equal(api.elements.get('#expandSchemaButton')?.textContent, 'Expand all');
    assert.equal(api.elements.get('#collapseSchemaButton')?.textContent, 'Collapse all');
    assert.equal(api.elements.get('#collapseSchemaButton')?.disabled, false);
    await api.elements.get('#collapseSchemaButton').click();
    assert(disclosures(api).every(node => !node.open));
    await api.elements.get('#languageButton').click();
    assert.equal(api.elements.get('#expandSchemaButton').textContent, 'すべて展開');
    assert.equal(api.elements.get('#collapseSchemaButton').textContent, 'すべて折りたたむ');
    assert(disclosures(api).every(node => !node.open));
    await api.elements.get('#expandSchemaButton').click();
    assert(disclosures(api).every(node => node.open));
    assert.equal(api.output.storage.length, 1, 'only the requested language change persists');
    assert.equal(api.elements.get('#schemaRaw').textContent, JSON.stringify(pairSchema, null, 2));
  });
  test(`${target}: collapse state survives file, view and language switches without leaking`, async () => {
    const api = load(target), first = await open(api, pairSchema);
    api.renderActive();
    const initial = disclosures(api); assert.equal(initial.length, 3);
    initial[1].open = false;
    // Native toggle may still be queued when another file becomes active.
    const second = await open(api, pairSchema, [], undefined, 'second.avro');
    api.renderActive();
    assert(disclosures(api).every(node => node.open), 'new file is expanded');
    await initial[1].dispatch('toggle');
    await api.elements.get('#collapseSchemaButton').click();
    api.activateFile(first.id);
    assert.deepEqual(disclosures(api).map(node => node.open), [true, false, true]);
    await api.elements.get('#schemaRawButton').click();
    assert.equal(api.elements.get('#expandSchemaButton').disabled, true);
    assert.equal(api.elements.get('#collapseSchemaButton').disabled, true);
    await api.elements.get('#languageButton').click();
    await api.elements.get('#schemaTreeButton').click();
    assert.deepEqual(disclosures(api).map(node => node.open), [true, false, true]);
    api.activateFile(second.id);
    assert(disclosures(api).every(node => !node.open));
    api.closeFile(second.id);
    assert.deepEqual(disclosures(api).map(node => node.open), [true, false, true]);
  });
  test(`${target}: individual toggles and repeated bulk actions preserve sibling independence`, async () => {
    const api = load(target), current = await open(api, pairSchema);
    api.renderActive();
    const initial = disclosures(api); assert.equal(initial.length, 3);
    initial[1].open = false; await initial[1].dispatch('toggle');
    api.renderSchema(current);
    assert.deepEqual(disclosures(api).map(node => node.open), [true, false, true]);
    await api.elements.get('#collapseSchemaButton').click();
    await api.elements.get('#collapseSchemaButton').click();
    assert(disclosures(api).every(node => !node.open));
    await api.elements.get('#expandSchemaButton').click();
    await api.elements.get('#expandSchemaButton').click();
    api.renderSchema(current);
    assert(disclosures(api).every(node => node.open));
    initial[1].open = false; await initial[1].dispatch('toggle');
    api.renderSchema(current);
    assert(disclosures(api).every(node => node.open), 'detached stale toggle cannot overwrite current state');
  });
  test(`${target}: primitive, empty, pending and failed files have no actionable tree controls`, async () => {
    const api = load(target);
    assert.equal(api.elements.get('#expandSchemaButton')?.disabled, true);
    assert.equal(api.elements.get('#copySchemaButton').disabled, true);
    for (const schema of ['string', { type: 'record', name: 'Empty', fields: [] }, { type: 'enum', name: 'Choice', symbols: ['A', 'B'] }, { type: 'fixed', name: 'Id', size: 4 }]) {
      const current = await open(api, schema); api.renderActive();
      assert.equal(disclosures(api).length, 0);
      assert.equal(api.elements.get('#expandSchemaButton').disabled, true);
      assert.equal(api.elements.get('#collapseSchemaButton').disabled, true);
      assert.equal(api.elements.get('#copySchemaButton').disabled, false);
      assert.equal(api.elements.get('#schemaRaw').textContent, JSON.stringify(schema, null, 2));
    }
    const pending = api.buildFileState(ocf(pairSchema)); api.state.files.push(pending); api.state.activeId = pending.id; api.renderActive();
    assert.equal(api.elements.get('#copySchemaButton').disabled, true);
    assert.equal(api.elements.get('#schemaRaw').textContent, '');
    pending.error = 'invalid'; pending.inspection = 'error'; api.renderActive();
    assert.equal(disclosures(api).length, 0);
    assert.equal(api.elements.get('#collapseSchemaButton').disabled, true);
    await api.elements.get('#copySchemaButton').dispatch('click');
    assert.deepEqual(api.output.clipboard, []);
    for (const current of [...api.state.files]) api.closeFile(current.id);
    assert.equal(api.elements.get('#schemaRaw').textContent, '');
    assert.equal(api.elements.get('#schemaTree').children.length, 0);
  });
  test(`${target}: Copy schema retains exact source text after every inspection action`, async () => {
    const api = load(target), original = '  \n' + JSON.stringify(selfSchema, null, 4) + '\n  ';
    const current = await open(api, selfSchema, [Buffer.concat([long(42), long(0)])], original);
    const before = Buffer.from(await current.file.arrayBuffer());
    api.renderActive();
    await api.elements.get('#collapseSchemaButton').click();
    await api.elements.get('#schemaRawButton').click();
    await api.elements.get('#copySchemaButton').click();
    await api.elements.get('#schemaTreeButton').click();
    await api.elements.get('#languageButton').click();
    await api.elements.get('#expandSchemaButton').click();
    await api.elements.get('#copySchemaButton').click();
    assert.deepEqual(api.output.clipboard, [original, original]);
    assert.equal(nodes(api, 'schema-reference')[0]?.textContent, '参照: example.Node');
    assert.equal(current.header.schemaText, original);
    assert.equal(JSON.stringify(current.header.schema), JSON.stringify(selfSchema));
    assert.deepEqual(Buffer.from(await current.file.arrayBuffer()), before);
  });
  test(`${target}: arrays, maps and unions preserve traversal order and logical labels`, async () => {
    const api = load(target), schema = { type: 'record', name: 'Bundle', fields: [
      { name: 'items', type: { type: 'array', items: { type: 'long', logicalType: 'timestamp-millis' } } },
      { name: 'lookup', type: { type: 'map', values: ['null', 'string'] } },
      { name: 'optional', type: ['null', { type: 'fixed', name: 'Amount', size: 4, logicalType: 'decimal', precision: 9, scale: 2 }] }
    ] };
    const current = await open(api, schema); api.renderActive();
    assert.equal(disclosures(api).length, 5);
    assert.deepEqual(nodes(api, 'schema-name').map(node => node.textContent), ['Bundle', 'items', 'items', 'lookup', 'values', '[0]', '[1]', 'optional', '[0]', '[1]']);
    assert.deepEqual(nodes(api, 'schema-logical').map(node => node.textContent), ['timestamp-millis', 'decimal']);
    assert.equal(new Set(disclosures(api).map(node => node.dataset.schemaPath)).size, 5);
    await api.elements.get('#collapseSchemaButton').click();
    assert(disclosures(api).every(node => !node.open));
  });

  test(`${target}: multi-file inspection survives recursive and invalid inputs and reopen resets state`, async () => {
    const api = load(target), recursive = ocf(selfSchema, [Buffer.concat([long(42), long(0)])]);
    const invalid = new Blob(['invalid']); invalid.name = 'invalid.avro'; invalid.lastModified = 0;
    const normal = ocf('string', [string('hello')], undefined, 'normal.avro');
    await api.addFiles([recursive, invalid, normal]);
    assert.deepEqual(Array.from(api.state.files, file => file.inspection), ['ready', 'error', 'ready']);
    assert.equal(api.state.files[0].rows[0].value.value, 42);
    assert.equal(api.state.files[2].rows[0].value, 'hello');
    assert.equal(nodes(api, 'schema-reference').length, 1);
    await api.elements.get('#collapseSchemaButton').click();
    assert(disclosures(api).every(node => !node.open));
    api.closeFile(api.state.files[0].id);
    await api.addFiles([recursive]);
    assert(disclosures(api).every(node => node.open));
    assert.equal(api.state.files.at(-1).collapsedSchemaPaths.size, 0);
  });
  test(`${target}: wide schemas and HTML-like labels stay complete plain text`, async () => {
    const api = load(target), schema = { type: 'record', name: 'Wide', fields: Array.from({ length: 80 }, (_, index) => ({ name: `field_${index}`, type: { type: 'array', items: 'string' } })) };
    const current = await open(api, schema); api.renderActive();
    assert.equal(disclosures(api).length, 81);
    assert.equal(nodes(api, 'schema-name').length, 161);
    await api.elements.get('#collapseSchemaButton').click();
    api.renderSchema(current); assert(disclosures(api).every(node => !node.open));
    const labels = { type: 'record', name: 'Literal', fields: [{ name: '<img src=x onerror=alert(1)>', type: 'string' }] };
    const labeled = await open(api, labels); api.renderActive();
    assert.equal(nodes(api, 'schema-name')[1].textContent, labels.fields[0].name);
    assert.equal(nodes(api, 'schema-name')[1].children.length, 0);
    assert.equal(nodes(api, 'schema-name')[1].innerHTML, undefined);
  });

  test(`${target}: cross-namespace references use the declaration namespace for labels and children`, async () => {
    const api = load(target), schema = { type: 'record', name: 'Root', namespace: 'one', fields: [
      { name: 'original', type: { type: 'record', name: 'Child', fields: [{ name: 'next', type: ['null', 'Child'] }] } },
      { name: 'other', type: { type: 'record', name: 'Other', namespace: 'two', fields: [
        { name: 'reused', type: 'one.Child' }
      ] } }
    ] };
    let current = await open(api, schema); api.renderActive();
    assert.deepEqual(nodes(api, 'schema-reference').map(node => node.textContent), ['Reference: one.Child', 'Reference: one.Child']);
    schema.fields[1].type.fields.unshift({ name: 'local', type: { type: 'record', name: 'Child', fields: [{ name: 'localOnly', type: 'string' }] } });
    current = await open(api, schema); api.renderActive();
    assert.deepEqual(nodes(api, 'schema-reference').map(node => node.textContent), ['Reference: one.Child', 'Reference: one.Child']);
    assert.equal(nodes(api, 'schema-name').filter(node => node.textContent === 'localOnly').length, 1, 'reused one.Child must not resolve next against two.Child');
    assert.equal(nodes(api, 'schema-name').filter(node => node.textContent === 'next').length, 2);
  });

}

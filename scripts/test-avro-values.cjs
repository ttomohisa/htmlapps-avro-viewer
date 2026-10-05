const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { gunzipSync } = require('node:zlib');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const targets = process.argv.slice(2);
if (!targets.length) targets.push('src/index.template.html', 'dist/index.html', 'dist/index.self-extract.html', 'avro-viewer.html');

// Test the actual inline app functions. These small DOM/clipboard adapters only
// capture output; this is a Node regression suite, not a browser UI test.
function load(relative) {
  let source = fs.readFileSync(path.resolve(root, relative), 'utf8');
  const payload = source.match(/<script id="self-extract-payload"[^>]*>([\s\S]*?)<\/script>/);
  if (payload) source = gunzipSync(Buffer.from(payload[1].trim(), 'base64')).toString('utf8');
  for (const script of source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  const start = source.indexOf('      function safeJson(');
  const end = source.indexOf("      $('#chooseButton').addEventListener", start);
  assert(start > 0 && end > start, `${relative}: application functions exist`);
  const element = () => ({ children: [], textContent: '', value: '', append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; }, showModal() {}, click() {} });
  const elements = new Map();
  const output = { clipboard: [], downloads: [], urls: [] };
  const state = { files: [], activeId: null };
  const context = vm.createContext({
    TextDecoder, TextEncoder, Uint8Array, DataView, Blob, Response, DecompressionStream,
    state, APP_CONFIG: { slug: 'avro-viewer' },
    $: selector => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); },
    document: { createElement: tag => { const el = element(); if (tag === 'a') el.click = () => output.downloads.push({ href: el.href, download: el.download }); return el; } },
    navigator: { clipboard: { writeText: async text => output.clipboard.push(text) } },
    URL: { createObjectURL: blob => { output.urls.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
    setTimeout() {}, toast() {}, t: key => key, formatNumber: String,
    basename: name => name.replace(/\.[^.]+$/, '')
  });
  vm.runInContext('const textDecoder = new TextDecoder();\n' + source.slice(start, end) + '\nglobalThis.api = {readHeader,scanBlocks,decodeBlock,buildNames,rootFields,buildCurrentCsv,prettyValue,cellText,valueForField,openCell,renderRecords,copyCsv,downloadCsv,sortedRows};', context);
  return { ...context.api, state, output, elements };
}

function long(value) {
  let n = BigInt(value); n = (n << 1n) ^ (n >> 63n);
  const out = [];
  do { const byte = Number(n & 127n); n >>= 7n; out.push(byte | (n ? 128 : 0)); } while (n);
  return Buffer.from(out);
}
const bytes = value => Buffer.concat([long(value.length), Buffer.from(value)]);
const string = value => bytes(Buffer.from(value, 'utf8'));
const hex = value => [...value].map(v => v.toString(16).padStart(2, '0')).join(' ');
const quote = value => /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
const sequence = length => Uint8Array.from({ length }, (_, i) => i);

async function decode(api, schema, data) {
  const sync = Buffer.from('0123456789abcdef');
  const metadata = Buffer.concat([long(2), string('avro.schema'), bytes(Buffer.from(JSON.stringify(schema))), string('avro.codec'), bytes(Buffer.from('null')), long(0)]);
  const datum = Buffer.concat(data);
  const container = Buffer.concat([Buffer.from([79, 98, 106, 1]), metadata, sync, long(data.length), long(datum.length), datum, sync]);
  assert(container.length < 2048, 'regression fixtures stay tiny');
  const file = new Blob([container]);
  file.name = 'example.avro';
  const header = await api.readHeader(file);
  const scanned = await api.scanBlocks(file, header);
  const current = { id: 'test', file, header, ...scanned, ctx: { names: api.buildNames(header.schema) }, blockCache: new Map(), blockCacheOrder: [], fields: api.rootFields(header.schema), hiddenFields: new Set(), sort: null, rows: [] };
  const values = await api.decodeBlock(current, current.blocks[0]);
  current.rows = values.map((value, index) => ({ recordNumber: index + 1, value }));
  api.state.files = [current]; api.state.activeId = current.id;
  return current;
}

for (const target of targets) {
  for (const length of [0, 31, 32, 33, 40, 95, 96, 97, 100]) {
    test(`${target}: complete bytes (${length}) in CSV and inspector, bounded table preview`, async () => {
      const api = load(target), value = sequence(length);
      const current = await decode(api, 'bytes', [bytes(value)]);
      assert.deepEqual([...current.rows[0].value], [...value]);
      assert.equal(api.buildCurrentCsv(current), '__record,__value\r\n1,' + hex(value));
      assert.equal(api.prettyValue(current.rows[0].value), hex(value));
      const preview = length > 32 ? hex(value.slice(0, 32)) + ` … (${length} bytes)` : hex(value);
      assert.equal(api.cellText(current.rows[0].value), preview);
    });
  }

  test(`${target}: nested record/array/map/union/fixed values retain every byte`, async () => {
    const api = load(target), value = sequence(100);
    const schema = { type: 'record', name: 'Envelope', fields: [
      { name: 'child', type: { type: 'record', name: 'Child', fields: [{ name: 'payload', type: 'bytes' }] } },
      { name: 'items', type: { type: 'array', items: 'bytes' } },
      { name: 'labels', type: { type: 'map', values: 'bytes' } },
      { name: 'optional', type: ['null', 'bytes'] },
      { name: 'fixed', type: { type: 'fixed', name: 'FixedBytes', size: 100 } }
    ] };
    const current = await decode(api, schema, [Buffer.concat([bytes(value), long(1), bytes(value), long(0), long(1), string('日本語'), bytes(value), long(0), long(1), bytes(value), Buffer.from(value)])]);
    const expected = { child: { payload: hex(value) }, items: [hex(value)], labels: { 日本語: hex(value) }, optional: hex(value), fixed: hex(value) };
    assert.equal(api.prettyValue(current.rows[0].value), JSON.stringify(expected, null, 2));
    assert.equal(api.buildCurrentCsv(current), '__record,child,items,labels,optional,fixed\r\n1,' + [JSON.stringify(expected.child), JSON.stringify(expected.items), JSON.stringify(expected.labels), expected.optional, expected.fixed].map(quote).join(','));
    assert(api.cellText(current.rows[0].value).includes('… (100 bytes)'), 'nested preview remains abbreviated');
    api.openCell(current.rows[0], 'child', current.rows[0].value.child);
    assert.equal(api.elements.get('#cellValue').textContent, JSON.stringify(expected.child, null, 2));
    assert.equal(api.state.activeCellText, JSON.stringify(expected.child, null, 2), 'Copy value receives the full inspector text');
    api.renderRecords(current);
    assert.equal(api.elements.get('#recordList').children[0].children[1].textContent, JSON.stringify(expected, null, 2));
  });

  test(`${target}: nested preview boundaries do not truncate full values`, async () => {
    const api = load(target);
    for (const length of [0, 95, 96, 97]) {
      const value = sequence(length);
      const schema = { type: 'array', items: { type: 'fixed', name: 'Boundary', size: length } };
      const current = await decode(api, schema, [Buffer.concat([long(1), Buffer.from(value), long(0)])]);
      assert.equal(api.buildCurrentCsv(current), '__record,__value\r\n1,' + quote(JSON.stringify([hex(value)])));
      const preview = length > 96 ? hex(value.slice(0, 96)) + ` … (${length} bytes)` : hex(value);
      assert.equal(api.cellText(current.rows[0].value), JSON.stringify([preview]));
    }
  });

  test(`${target}: real __value record field selects, sorts and exports its own value`, async () => {
    const api = load(target);
    const schema = { type: 'record', name: 'Measurement', fields: [{ name: '__value', type: 'string' }, { name: 'unit', type: 'string' }] };
    const current = await decode(api, schema, [Buffer.concat([string('Beta'), string('widgets')]), Buffer.concat([string('Alpha'), string('gadgets')])]);
    const field = current.fields[0];
    assert.equal(api.valueForField(current.rows[0].value, field), 'Beta');
    current.sort = { field, dir: 1 };
    assert.equal(api.buildCurrentCsv(current), '__record,__value,unit\r\n2,Alpha,gadgets\r\n1,Beta,widgets');
    current.hiddenFields.add(1);
    assert.equal(api.buildCurrentCsv(current), '__record,__value\r\n2,Alpha\r\n1,Beta');
    current.sort.dir = -1;
    assert.equal(api.buildCurrentCsv(current), '__record,__value\r\n1,Beta\r\n2,Alpha');
  });

  test(`${target}: synthetic root values preserve primitive and composite schemas`, async () => {
    const api = load(target);
    for (const [schema, data, expected] of [
      ['string', string('Alpha'), 'Alpha'],
      ['null', Buffer.alloc(0), 'null'],
      ['boolean', Buffer.from([0]), 'false'],
      ['long', long(9007199254740993n), '9007199254740993'],
      [{ type: 'map', values: 'string' }, Buffer.concat([long(1), string('__value'), string('Alpha'), long(0)]), '{"__value":"Alpha"}'],
      [['null', { type: 'record', name: 'Wrapped', fields: [{ name: '__value', type: 'string' }] }], Buffer.concat([long(1), string('Alpha')]), '{"__value":"Alpha"}']
    ]) {
      const current = await decode(api, schema, [data]);
      assert.equal(api.buildCurrentCsv(current), '__record,__value\r\n1,' + quote(expected));
    }
    assert.equal(api.prettyValue(undefined), '');
    assert.equal(api.prettyValue({ long: 9007199254740993n, empty: null }), '{\n  "long": "9007199254740993",\n  "empty": null\n}');
  });

  test(`${target}: copy/save use full CSV with quotes, Unicode, CRLF and saved BOM/filename`, async () => {
    const api = load(target), value = sequence(40), memo = 'Demo,"line"\n日本語';
    const schema = { type: 'record', name: 'Export', fields: [{ name: 'payload', type: 'bytes' }, { name: 'memo', type: 'string' }] };
    await decode(api, schema, [Buffer.concat([bytes(value), string(memo)])]);
    const expected = '__record,payload,memo\r\n1,' + hex(value) + ',' + quote(memo);
    api.elements.set('#outputFilename', { value: 'custom name.csv' });
    await api.copyCsv();
    assert.equal(api.output.clipboard[0], expected);
    api.downloadCsv();
    assert.equal(api.output.downloads[0].download, 'custom name.csv');
    const saved = Buffer.from(await api.output.urls[0].arrayBuffer());
    assert.deepEqual(saved, Buffer.from('\uFEFF' + expected));
  });
}

if (!process.argv.slice(2).length) {
  test('tracked root alias matches the readable build except its build timestamp', () => {
    const normalize = text => text.replace(/\r\n/g, '\n').replace(/("generatedAtUtc":")[^"]+("\s*[,}])/g, '$1<build-time>$2');
    assert.equal(normalize(fs.readFileSync(path.join(root, 'avro-viewer.html'), 'utf8')), normalize(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')), 'Rebuild and copy dist/index.html to avro-viewer.html before committing.');
  });
}

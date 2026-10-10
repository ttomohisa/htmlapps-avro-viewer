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
  vm.runInContext('const textDecoder = new TextDecoder();\n' + source.slice(start, end) + '\nglobalThis.api = {readHeader,scanBlocks,decodeBlock,buildNames,rootFields,buildCurrentCsv,prettyValue,cellText,valueForField,openCell,renderRecords,copyCsv,downloadCsv,sortedRows,readPage};', context);
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
  return decodeContainer(api, container);
}

async function decodeContainer(api, container, pageSize = 1000) {
  const file = new Blob([container]);
  file.name = 'example.avro';
  const header = await api.readHeader(file);
  const scanned = await api.scanBlocks(file, header);
  const current = { id: 'test', inspection: 'ready', file, header, ...scanned, ctx: { names: api.buildNames(header.schema) }, blockCache: new Map(), blockCacheOrder: [], fields: api.rootFields(header.schema), hiddenFields: new Set(), sort: null, rows: [], page: 1, pageSize };
  api.state.activeId = null;
  await api.readPage(current);
  assert.equal(current.dataError, '', 'the actual Avro file decodes without error');
  api.state.files = [current]; api.state.activeId = current.id;
  return current;
}


// Signed big-endian coefficients are encoded as Avro bytes/fixed, never as
// synthetic already-decoded decimal objects.
function coefficientBytes(coefficient, width) {
  let n = BigInt(coefficient), size = width || 1;
  while (!width && (n < -(1n << BigInt(size * 8 - 1)) || n >= 1n << BigInt(size * 8 - 1))) size++;
  assert(n >= -(1n << BigInt(size * 8 - 1)) && n < 1n << BigInt(size * 8 - 1));
  if (n < 0n) n += 1n << BigInt(size * 8);
  const result = Buffer.alloc(size);
  for (let i = size - 1; i >= 0; i--) { result[i] = Number(n & 255n); n >>= 8n; }
  return result;
}
const sortedRecordNumbers = (api, current) => Array.from(api.sortedRows(current), row => row.recordNumber);

for (const target of targets) {
  test(`${target}: browser regression fixture sorts decimal amounts numerically on each page`, async () => {
    const api = load(target);
    const current = await decodeContainer(api, fs.readFileSync(path.join(__dirname, 'fixtures/avro-known-205.avro')), 100);
    assert.equal(current.totalRows, 205);
    assert.equal(current.blocks.length, 3);
    const field = current.fields.find(f => f.name === 'amount');
    assert.deepEqual({ ...field.type }, { type: 'bytes', logicalType: 'decimal', precision: 9, scale: 2 });
    for (const page of [1, 2, 3]) {
      current.page = page;
      api.state.activeId = null;
      await api.readPage(current);
      api.state.activeId = current.id;
      assert.equal(current.dataError, '');
      const original = Array.from(current.rows, row => row.recordNumber);
      current.sort = { field, dir: 1 };
      assert.deepEqual(sortedRecordNumbers(api, current), original, 'ascending uses numeric amount order within this page');
      if (page === 1) assert.deepEqual(Array.from(api.sortedRows(current).slice(0, 4), row => row.value.amount), ['-1.25', '2.50', '3.75', '5.00']);
      current.sort.dir = -1;
      assert.deepEqual(sortedRecordNumbers(api, current), [...original].reverse());
      assert.deepEqual(Array.from(current.rows, row => row.recordNumber), original, 'sorting does not mutate cached/source rows');
      assert.equal(api.sortedRows(current)[0].value.amount, page === 1 ? '125.00' : page === 2 ? '250.00' : '256.25');
      current.hiddenFields = new Set(current.fields.filter(f => f !== field).map(f => f.index));
      const first = api.sortedRows(current)[0];
      assert.equal(api.buildCurrentCsv(current).split('\r\n')[1], `${first.recordNumber},${first.value.amount}`);
      current.sort = null;
      assert.deepEqual(sortedRecordNumbers(api, current), original);
    }
  });

  test(`${target}: nullable decimals preserve exact large coefficients, signs, stable ties and null-last`, async () => {
    const api = load(target);
    const schema = { type: 'record', name: 'Precise', fields: [{ name: 'amount', type: ['null', { type: 'bytes', logicalType: 'decimal', precision: 30, scale: 2 }] }] };
    const values = [null, 1000n, 900719925474099302n, -900719925474099301n, 1n, -1n, 0n, 125n, 125n, 900719925474099301n, -900719925474099302n, null];
    const current = await decode(api, schema, values.map(n => n === null ? long(0) : Buffer.concat([long(1), bytes(coefficientBytes(n))])));
    assert.equal(current.rows[2].value.amount, '9007199254740993.02');
    assert.equal(current.rows[3].value.amount, '-9007199254740993.01');
    const original = current.rows.map(row => row.value.amount);
    current.sort = { field: current.fields[0], dir: 1 };
    assert.deepEqual(sortedRecordNumbers(api, current), [11, 4, 6, 7, 5, 8, 9, 2, 10, 3, 1, 12]);
    current.sort.dir = -1;
    assert.deepEqual(sortedRecordNumbers(api, current), [3, 10, 2, 8, 9, 5, 7, 6, 4, 11, 1, 12]);
    assert.equal(api.buildCurrentCsv(current), '__record,amount\r\n3,9007199254740993.02\r\n10,9007199254740993.01\r\n2,10.00\r\n8,1.25\r\n9,1.25\r\n5,0.01\r\n7,0.00\r\n6,-0.01\r\n4,-9007199254740993.01\r\n11,-9007199254740993.02\r\n1,null\r\n12,null');
    assert.deepEqual(current.rows.map(row => row.value.amount), original);
    assert.equal(api.cellText(current.rows[1].value.amount), '10.00');
    assert.equal(api.prettyValue(current.rows[1].value.amount), '10.00');
    api.openCell(current.rows[1], 'amount', current.rows[1].value.amount);
    assert.equal(api.state.activeCellText, '10.00');
  });

  test(`${target}: root bytes decimals use scale zero by default and preserve large precision`, async () => {
    for (const scale of [undefined, 0, 25]) {
      const api = load(target), schema = { type: 'bytes', logicalType: 'decimal', precision: 40 };
      if (scale !== undefined) schema.scale = scale;
      const current = await decode(api, schema, [10n, 2n, -10n, -2n, 9007199254740993n, 9007199254740992n].map(n => bytes(coefficientBytes(n))));
      current.sort = { field: current.fields[0], dir: 1 };
      assert.deepEqual(sortedRecordNumbers(api, current), [3, 4, 2, 1, 6, 5]);
      assert.equal(current.rows[0].value, scale === 25 ? '0.0000000000000000000000010' : '10');
    }
  });

  test(`${target}: fixed decimal declarations and namespaced nullable references retain numeric order`, async () => {
    const api = load(target);
    const schema = { type: 'record', name: 'Envelope', namespace: 'finance', fields: [
      { name: 'definition', type: { type: 'fixed', name: 'Money', size: 16, logicalType: 'decimal', precision: 30, scale: 2 } },
      { name: '__value', type: ['Money', 'null'] },
      { name: 'qualified', type: { type: 'finance.Money' } }
    ] };
    const current = await decode(api, schema, [1000n, 250n, -125n].map(n => Buffer.concat([coefficientBytes(n, 16), long(0), coefficientBytes(n, 16), coefficientBytes(n, 16)])));
    for (const field of current.fields) {
      current.sort = { field, dir: 1 };
      assert.deepEqual(sortedRecordNumbers(api, current), [3, 2, 1], field.name);
    }
    assert.equal(api.buildCurrentCsv(current), '__record,definition,__value,qualified\r\n3,-1.25,-1.25,-1.25\r\n2,2.50,2.50,2.50\r\n1,10.00,10.00,10.00');
  });

  test(`${target}: wrappers preserve declared decimal sorting without changing nested value decoding`, async () => {
    for (const schema of [
      { type: { type: 'bytes', logicalType: 'decimal', precision: 6, scale: 2 } },
      { type: ['null', { type: 'bytes', logicalType: 'decimal', precision: 6, scale: 2 }] }
    ]) {
      const api = load(target), union = Array.isArray(schema.type);
      const current = await decode(api, schema, [1000n, 250n, -125n].map(n => Buffer.concat([...(union ? [long(1)] : []), bytes(coefficientBytes(n))])));
      current.sort = { field: current.fields[0], dir: 1 };
      assert.deepEqual(sortedRecordNumbers(api, current), [3, 2, 1]);
    }
  });

  test(`${target}: numeric-looking strings and mixed string/decimal unions keep lexical ordering`, async () => {
    for (const schema of ['string', { type: 'string', logicalType: 'decimal', precision: 6, scale: 2 }, ['string', { type: 'bytes', logicalType: 'decimal', precision: 6, scale: 2 }]]) {
      const api = load(target), union = Array.isArray(schema);
      const data = union ? [Buffer.concat([long(0), string('2.50')]), Buffer.concat([long(1), bytes(coefficientBytes(1000n))]), Buffer.concat([long(0), string('001.00')])] : ['2.50', '10.00', '001.00'].map(string);
      const current = await decode(api, schema, data);
      current.sort = { field: current.fields[0], dir: 1 };
      assert.deepEqual(sortedRecordNumbers(api, current), [3, 2, 1]);
      current.sort.dir = -1;
      assert.deepEqual(sortedRecordNumbers(api, current), [1, 2, 3]);
    }
  });

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

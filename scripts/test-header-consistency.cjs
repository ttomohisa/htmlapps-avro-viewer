const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { gunzipSync } = require('node:zlib');
const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'app.config.json'), 'utf8'));
const schema = config.slug.endsWith('schema-diff');
const artifactPaths = process.argv.slice(2);
for (const artifact of artifactPaths.length ? artifactPaths : [path.join(root, 'src/index.template.html')]) {
  let html = fs.readFileSync(artifact, 'utf8');
  const payload = html.match(/id="self-extract-payload"[^>]*>([A-Za-z0-9+/=\r\n]+)<\/script>/);
  if (payload) html = gunzipSync(Buffer.from(payload[1], 'base64')).toString('utf8');
  const dictionary = html.match(/const (?:I18N|translations)\s*=\s*(\{[\s\S]*?\n\s*\}{1,2});/)?.[1];
  assert.ok(dictionary, 'Locate actual application translations');
  const translations = vm.runInNewContext('(' + dictionary + ')');
  const functionName = 'applyLanguage';
  const applySource = html.match(/function applyLanguage\(\) \{[\s\S]*?\n      \}/)?.[0] || html.split(/\r?\n/).find(line => line.trimStart().startsWith('function applyLanguage('));
  assert.ok(applySource, 'Locate the production language update function');
  const languageId = 'languageButton';
  const helpId = 'helpButton';
  const badgeKey = 'localBadge';

  // Execute the unchanged production language updater against attributes parsed
  // from the actual HTML. Rendering boundaries are stubbed: this is not browser QA.
  function harness() {
    const nodes = [];
    for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*?)>/gi)) {
      const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
      const node = { attrs, dataset: {}, textContent: '', setAttribute(k,v){ attrs[k]=String(v); }, getAttribute(k){ return attrs[k] ?? null; } };
      Object.defineProperty(node, 'title', { get(){return attrs.title || '';}, set(value){attrs.title=String(value);} });
      for (const [key,value] of Object.entries(attrs)) if (key.startsWith('data-')) node.dataset[key.slice(5).replace(/-([a-z])/g, (_,letter)=>letter.toUpperCase())]=value;
      nodes.push(node);
    }
    const get = id => { const node=nodes.find(n=>n.attrs.id===id.replace(/^#/,'')); assert.ok(node,`Actual element ${id} exists`); return node; };
    const all = selector => nodes.filter(n=>Object.hasOwn(n.attrs,selector.slice(1,-1)));
    const state = { language:'ja', data:[{id:1,value:'東京',amount:null}], page:3, pageSize:100, search:[{path:'$[0].value'}], files:[{id:'one',raw:'9007199254740993'}], activeId:'one' };
    const document = { documentElement:{lang:'ja'}, querySelectorAll:all };
    const context = vm.createContext({document,state,APP_CONFIG:config,I18N:translations,$:get,$$:all,renderActive(){},renderFileManager(){},getActiveFile(){return state.files[0];},renderFileStatus(){},renderOverview(){},renderFields(){},renderColumnsDialog(){},renderDataTable(){},renderSide(){},renderResults(){},updateButtons(){}});
    vm.runInContext(`let language='ja';const lastDiff={summary:{changed:1},rows:[{path:'id',changes:['type']}]}; function t(key,vars={}){return String(I18N[${schema?'language':'state.language'}][key]??key).replace(/\\{(\\w+)\\}/g,(_,k)=>vars[k]??'');} ${applySource};globalThis.switchTo=next=>{language=next;state.language=next;${functionName}();};`,context);
    return {get,nodes,state,document,switchTo:context.switchTo};
  }
  for (const lang of ['ja','en']) {
    test(`${artifact}: ${lang} target language text and accessible name`,()=>{
      const h=harness();h.switchTo(lang);const button=h.get(languageId);
      assert.equal(button.textContent,lang==='ja'?'EN':'JA');
      assert.equal(button.getAttribute('aria-label'),lang==='ja'?'英語に切り替え':'Switch to Japanese');
      assert.equal(button.title,button.getAttribute('aria-label'));
      assert.equal(h.document.documentElement.lang,lang);
    });
    test(`${artifact}: ${lang} local-processing badge`,()=>{
      const h=harness();h.switchTo(lang);const badge=h.nodes.find(n=>n.dataset.i18n===badgeKey);
      assert.ok(badge);assert.equal(badge.textContent,lang==='ja'?'完全ローカル処理':'Fully local processing');
    });
    test(`${artifact}: ${lang} localized Help name and title`,()=>{
      const h=harness();h.switchTo(lang);
      const help=h.get(helpId);assert.equal(help.getAttribute('aria-label'),translations[lang].helpTitle);
      assert.equal(help.title,translations[lang].helpTitle);
    });
  }
  test(`${artifact}: repeated language updates preserve data, paging and search state`,()=>{
    const h=harness(),before=JSON.stringify({...h.state,language:undefined});
    for(const lang of ['en','ja','en','ja']) h.switchTo(lang);
    assert.equal(JSON.stringify({...h.state,language:undefined}),before);
  });
  test(`${artifact}: initial Japanese header and Help have localized target names`,()=>{
    const h=harness(),button=h.get(languageId);
    assert.equal(button.getAttribute('aria-label'),'英語に切り替え');assert.equal(button.title,'英語に切り替え');
    const help=h.get(helpId);assert.equal(help.getAttribute('aria-label'),'使い方と注意事項');assert.equal(help.title,'使い方と注意事項');
  });
  test(`${artifact}: synchronized three-part version`,()=>{
    assert.match(config.version,/^\d+\.\d+\.\d+$/);
    assert.match(html,new RegExp('class="'+'version-badge'+'"[^>]*>v'+config.version.replace(/\./g,'\\.')+'<'));
  });
}

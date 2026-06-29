// Headless smoke test: run the viewer's app.js against a minimal DOM stub
// to confirm the tree renders and node selection works without runtime errors.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dir, '..');

const html = fs.readFileSync(path.join(root, 'ai-history-export', 'index.html'), 'utf8');
const dataJson = html.match(/<script id="devlog-data"[^>]*>([\s\S]*?)<\/script>/)[1];
const appJs = fs.readFileSync(path.join(root, 'template', 'app.js'), 'utf8');

// ---- minimal DOM ----
let clickHandlers = [];
function makeEl(tag) {
  const el = {
    tag, children: [], _text: '', _html: '', dataset: {}, attrs: {},
    classes: new Set(),
    classList: {
      add: (c) => el.classes.add(c), remove: (c) => el.classes.delete(c),
      toggle: (c) => (el.classes.has(c) ? el.classes.delete(c) : el.classes.add(c)),
      contains: (c) => el.classes.has(c),
    },
    set className(v) { el.classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className() { return [...el.classes].join(' '); },
    set textContent(v) { el._text = String(v); },
    get textContent() { return el._text; },
    set innerHTML(v) { el._html = String(v); },
    get innerHTML() { return el._html; },
    appendChild: (c) => { el.children.push(c); c.parent = el; return c; },
    addEventListener: (ev, fn) => { if (ev === 'click') clickHandlers.push({ el, fn }); },
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    parent: null,
  };
  return el;
}
const registry = {};
['proj-name', 'proj-sub', 'stats', 'f-types', 'f-sources', 'tree', 'detail', 'search'].forEach((id) => {
  registry[id] = makeEl('div');
});
registry['devlog-data'] = makeEl('script');
registry['devlog-data']._text = dataJson;

const document = {
  getElementById: (id) => registry[id] || makeEl('div'),
  createElement: (t) => makeEl(t),
};
const sandbox = { document, JSON, Date, RegExp, console, Array, Object, Math, String };
sandbox.window = sandbox;

let ok = true;
try {
  vm.runInNewContext(appJs, sandbox);
  // assertions
  const tree = registry['tree'];
  const detail = registry['detail'];
  const projName = registry['proj-name']._text;
  if (!projName) throw new Error('project name not set');
  // tree should have rendered a <ul> with children
  const ul = tree.children[0];
  if (!ul || !ul.children.length) throw new Error('tree did not render session rows');
  // detail should have auto-selected something (innerHTML set)
  if (!detail._html || detail._html.indexOf('<h2>') < 0) throw new Error('detail pane not populated');
  console.log('✓ project name:', projName);
  console.log('✓ tree rendered top-level rows:', ul.children.length);
  console.log('✓ click handlers wired:', clickHandlers.length);
  console.log('✓ detail auto-selected, html length:', detail._html.length);

  // exercise a click on a node row to ensure select() runs without error
  const someRow = clickHandlers.find((h) => h.el.classes.has('node-row'));
  if (someRow) { someRow.fn(); console.log('✓ node click select() ran OK'); }
  console.log('\nSMOKE TEST PASSED');
} catch (e) {
  ok = false;
  console.error('SMOKE TEST FAILED:', e.message);
}
process.exit(ok ? 0 : 1);

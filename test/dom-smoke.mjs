// Headless smoke test: run the tree-canvas viewer against a minimal DOM/SVG
// stub to confirm it renders nodes/links and the click→drawer path works.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dir, '..');
const html = fs.readFileSync(path.join(root, 'ai-history-export', 'index.html'), 'utf8');
const dataJson = html.match(/<script id="devlog-data"[^>]*>([\s\S]*?)<\/script>/)[1];
const appJs = fs.readFileSync(path.join(root, 'template', 'app.js'), 'utf8');

function makeEl(tag) {
  const el = {
    tag, children: [], _text: '', _html: '', attrs: {}, _handlers: {}, classes: new Set(),
    classList: {
      add: (c) => el.classes.add(c), remove: (c) => el.classes.delete(c),
      toggle: (c) => (el.classes.has(c) ? el.classes.delete(c) : el.classes.add(c)),
      contains: (c) => el.classes.has(c),
    },
    setAttribute: (k, v) => { el.attrs[k] = v; }, getAttribute: (k) => el.attrs[k],
    set className(v) { el.classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className() { return [...el.classes].join(' '); },
    set textContent(v) { el._text = String(v); }, get textContent() { return el._text; },
    set innerHTML(v) { el._html = String(v); }, get innerHTML() { return el._html; },
    get firstChild() { return el.children[0] || null; },
    appendChild: (c) => { el.children.push(c); return c; },
    removeChild: (c) => { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); },
    addEventListener: (ev, fn) => { el._handlers[ev] = fn; },
    setPointerCapture: () => {}, releasePointerCapture: () => {},
    closest: () => null,
    getBoundingClientRect: () => ({ width: 1280, height: 800, left: 0, top: 0 }),
  };
  return el;
}
const ids = ['proj-name', 'proj-sub', 'stats', 'canvas', 'viewport', 'links', 'nodes', 'legend', 'drawer', 'drawer-close', 'drawer-body', 'search', 'reset'];
const reg = {};
ids.forEach((id) => { reg[id] = makeEl('div'); });
reg['devlog-data'] = makeEl('script'); reg['devlog-data']._text = dataJson;

const document = {
  getElementById: (id) => reg[id] || makeEl('div'),
  createElement: (t) => makeEl(t),
  createElementNS: (_ns, t) => makeEl(t),
};
const sandbox = { document, JSON, Date, RegExp, console, Array, Object, Math, String, Set, Infinity, isNaN, Number };
sandbox.window = sandbox;

let ok = true;
try {
  vm.runInNewContext(appJs, sandbox);
  const nodesG = reg['nodes'], linksG = reg['links'];
  if (!nodesG.children.length) throw new Error('no node cards rendered');
  if (!linksG.children.length) throw new Error('no links rendered');
  if (!reg['proj-name']._text) throw new Error('project name not set');
  if (reg['stats']._html.indexOf('ideas') < 0) throw new Error('stats not populated');
  console.log('✓ project:', reg['proj-name']._text);
  console.log('✓ node cards rendered:', nodesG.children.length);
  console.log('✓ links rendered:', linksG.children.length);

  // find an idea node id from the data, simulate a card click → drawer
  const data = JSON.parse(dataJson);
  let ideaId = null;
  (function find(n) { if (!ideaId && /^(idea|refine|fix|question|decision|verification)$/.test(n.type)) ideaId = n.id; (n.children || []).forEach(find); })(data.tree);
  if (!ideaId) throw new Error('no idea node in data');
  const click = nodesG._handlers['click'];
  click({ target: { closest: (sel) => (sel === '.toggle' ? null : { getAttribute: () => ideaId }) } });
  if (!reg['drawer'].classes.has('open')) throw new Error('drawer did not open on click');
  if (reg['drawer-body']._html.indexOf('d-title') < 0) throw new Error('drawer detail not rendered');
  console.log('✓ click → drawer opened, detail length:', reg['drawer-body']._html.length);
  console.log('\nSMOKE TEST PASSED');
} catch (e) {
  ok = false;
  console.error('SMOKE TEST FAILED:', e.message);
}
process.exit(ok ? 0 : 1);

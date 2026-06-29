// Exporter: tree + stats -> a single self-contained index.html (offline-safe).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(__dir, '..', 'template');

// Embed JSON in a <script> tag without letting "</script>" break out.
function safeJson(obj) {
  return JSON.stringify(obj).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

export function exportHtml(payload, outDir) {
  const html = fs.readFileSync(path.join(TEMPLATE, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(TEMPLATE, 'style.css'), 'utf8');
  const app = fs.readFileSync(path.join(TEMPLATE, 'app.js'), 'utf8');

  const out = html
    .replace('/*__STYLE__*/', () => css)
    .replace('/*__DATA__*/', () => safeJson(payload))
    .replace('/*__APP__*/', () => app);

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'index.html');
  fs.writeFileSync(file, out, 'utf8');

  // also drop the raw data for re-use / MCP / other tooling
  fs.mkdirSync(path.join(outDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'data', 'devlog.json'), JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

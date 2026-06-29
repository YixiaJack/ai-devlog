// Auto-discovery of local AI coding sessions (Claude Code + Codex CLI).
// Web chats (ChatGPT / Claude web) have no local session file and stay manual.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isCodexPreamble, codexLabelFromFile } from './parsers.mjs';

const HOME = os.homedir();

const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');

// Claude Code encodes a project's cwd into its folder name by replacing every
// non-alphanumeric char with "-"  (e.g. C:\Users\me -> C--Users-me).
export function encodeClaudeProject(p) {
  return path.resolve(p).replace(/[^a-zA-Z0-9]/g, '-');
}

function walkJsonl(dir, out = [], depth = 0) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 6) walkJsonl(fp, out, depth + 1); }
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(fp);
  }
  return out;
}

// read only the head of a (possibly large) jsonl to sniff cwd / title
function readHead(file, bytes = 131072) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch { return ''; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function peekClaude(file) {
  let cwd = null, title = null;
  for (const l of readHead(file).split(/\r?\n/)) {
    if (!l) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!title && o.type === 'ai-title' && o.aiTitle) title = o.aiTitle;
    if (cwd && title) break;
  }
  return { cwd, title };
}

function peekCodex(file) {
  let cwd = null, title = null;
  for (const l of readHead(file).split(/\r?\n/)) {
    if (!l) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    const p = o.payload || {};
    if (!cwd && o.type === 'session_meta' && p.cwd) cwd = p.cwd;
    if (!title && o.type === 'response_item' && p.role === 'user' && Array.isArray(p.content)) {
      const t = p.content.map((b) => b && b.text).filter(Boolean).join(' ').trim();
      if (t && !isCodexPreamble(t)) title = t.split(/\r?\n/)[0].slice(0, 60);
    }
    if (cwd && title) break;
  }
  return { cwd, title };
}

function mtime(f) { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }

export function findClaudeCode({ project, all } = {}) {
  const base = path.join(HOME, '.claude', 'projects');
  if (!fs.existsSync(base)) return [];
  let files;
  if (project && !all) {
    const dir = path.join(base, encodeClaudeProject(project));
    files = walkJsonl(dir);
    if (!files.length) files = walkJsonl(base); // fallback: encoding/case drift
  } else {
    files = walkJsonl(base);
  }
  files = files.filter((f) => !/[\\/]subagents[\\/]/.test(f)); // skip subagent noise
  const target = project && !all ? norm(project) : null;
  const out = [];
  for (const f of files) {
    const meta = peekClaude(f);
    if (target && meta.cwd && norm(meta.cwd) !== target) continue;
    out.push({ source: 'claude-code', file: f, cwd: meta.cwd, title: meta.title, mtime: mtime(f) });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function findCodex({ project, all } = {}) {
  const base = path.join(HOME, '.codex', 'sessions');
  if (!fs.existsSync(base)) return [];
  const files = walkJsonl(base).filter((f) => /rollout-.*\.jsonl$/.test(path.basename(f)));
  const target = project && !all ? norm(project) : null;
  const out = [];
  for (const f of files) {
    const meta = peekCodex(f);
    if (target && meta.cwd && norm(meta.cwd) !== target) continue;
    out.push({ source: 'codex', file: f, cwd: meta.cwd, title: meta.title || codexLabelFromFile(f), mtime: mtime(f) });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function discover({ project, all } = {}) {
  return { claudeCode: findClaudeCode({ project, all }), codex: findCodex({ project, all }) };
}

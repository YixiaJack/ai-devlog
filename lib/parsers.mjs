// Parsers: convert each AI chat source into a normalized message stream.
//
// Normalized message shape:
//   { id, source, sessionId, role, content, timestamp, model,
//     files:[], commits:[], diff:null }
//
// role: 'user' | 'assistant' | 'tool' | 'system'

import fs from 'node:fs';
import path from 'node:path';

let _seq = 0;
const nextId = (p = 'm') => `${p}_${(++_seq).toString(36)}`;

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

// ---------- helpers ----------

// Pull file paths mentioned in fenced ```lang path``` headers or prose.
function guessFiles(text) {
  const files = new Set();
  const re = /(?:^|\s)([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|css|scss|html|json|yml|yaml|md|sql|sh))\b/g;
  let m;
  while ((m = re.exec(text)) !== null) files.add(m[1]);
  return [...files];
}

function guessCommits(text) {
  const out = new Set();
  const re = /\b([0-9a-f]{7,40})\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // crude: only accept if it looks like a hash near "commit"
    out.add(m[1]);
  }
  return [...out];
}

// ---------- generic (our own JSON schema) ----------

export function parseGeneric(file) {
  const data = JSON.parse(read(file));
  const project = data.project || {};
  const msgs = (data.messages || []).map((m) => ({
    id: m.id || nextId(),
    source: m.source || data.source || 'generic',
    sessionId: m.sessionId || data.sessionId || 'session',
    role: m.role || 'user',
    content: m.content || m.contentMarkdown || '',
    timestamp: m.timestamp || null,
    model: m.model || null,
    files: m.files || (m.linksTo && m.linksTo.files) || [],
    commits: m.commits || (m.linksTo && m.linksTo.commits) || [],
    diff: m.diff || null,
  }));
  return { project, messages: msgs };
}

// ---------- markdown (Aider / ChatGPT-copy / generic) ----------
// Splits on headings whose text names a role, or on Aider-style "#### " user lines.

export function parseMarkdown(file, source = 'markdown', sessionId) {
  const text = read(file);
  sessionId = sessionId || path.basename(file);
  const lines = text.split(/\r?\n/);
  const messages = [];
  let cur = null;

  const roleOf = (heading) => {
    const h = heading.toLowerCase();
    if (/\b(user|you|human|me)\b/.test(h)) return 'user';
    if (/\b(assistant|ai|claude|gpt|model|bot|aider)\b/.test(h)) return 'assistant';
    if (/\b(system)\b/.test(h)) return 'system';
    if (/\b(tool|function)\b/.test(h)) return 'tool';
    return null;
  };
  const push = () => {
    if (cur && cur.content.trim()) {
      cur.content = cur.content.trim();
      cur.files = guessFiles(cur.content);
      messages.push(cur);
    }
    cur = null;
  };

  for (const line of lines) {
    const head = line.match(/^#{1,6}\s+(.*)$/);
    if (head) {
      const role = roleOf(head[1]);
      if (role) {
        push();
        cur = { id: nextId(), source, sessionId, role, content: '', timestamp: null, model: null, files: [], commits: [], diff: null };
        continue;
      }
    }
    if (!cur) {
      cur = { id: nextId(), source, sessionId, role: 'assistant', content: '', timestamp: null, model: null, files: [], commits: [], diff: null };
    }
    cur.content += line + '\n';
  }
  push();
  return { project: {}, messages };
}

// Aider's .aider.chat.history.md uses "#### " for user lines; everything else
// is the assistant. There's no assistant delimiter, so split on the role of
// each line and flush whenever the role flips.
export function parseAider(file) {
  const text = read(file);
  const sessionId = path.basename(file);
  const lines = text.split(/\r?\n/);
  const messages = [];
  let role = null;
  let buf = [];
  const flush = () => {
    const content = buf.join('\n').trim();
    if (content && role) {
      messages.push({
        id: nextId(), source: 'aider', sessionId, role, content,
        timestamp: null, model: null, files: guessFiles(content), commits: [], diff: null,
      });
    }
    buf = [];
  };
  for (const line of lines) {
    if (/^#\s/.test(line)) continue; // skip aider's "# aider chat started at ..." header (H1)
    const isUser = /^####\s?/.test(line);
    const lineRole = isUser ? 'user' : 'assistant';
    if (role === null) role = lineRole;
    if (lineRole !== role) { flush(); role = lineRole; }
    buf.push(isUser ? line.replace(/^####\s?/, '') : line);
  }
  flush();
  return { project: {}, messages };
}

// ---------- Claude Code (JSONL session) ----------

export function parseClaudeCode(file) {
  const text = read(file);
  const messages = [];
  let project = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const role = o.type === 'user' ? 'user' : o.type === 'assistant' ? 'assistant' : o.role || null;
    if (!role) continue;
    if (o.cwd) project.repoRoot = o.cwd;
    if (o.gitBranch) project.branch = o.gitBranch;

    const msg = o.message || {};
    let content = '';
    const files = [];
    const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'text' || typeof b === 'string') content += (b.text || b) + '\n';
      else if (b.type === 'tool_use') {
        const inp = b.input || {};
        if (inp.file_path) files.push(inp.file_path);
        content += `\n> tool: **${b.name}** ${inp.file_path ? '`' + inp.file_path + '`' : ''}\n`;
      } else if (b.type === 'tool_result') {
        const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        content += `\n> tool result: ${t.slice(0, 400)}\n`;
      }
    }
    messages.push({
      id: o.uuid || nextId(),
      source: 'claude-code',
      sessionId: o.sessionId || 'claude-session',
      role,
      content: content.trim(),
      timestamp: o.timestamp || null,
      model: msg.model || null,
      files: [...new Set(files)],
      commits: [],
      diff: null,
    });
  }
  return { project, messages };
}

// ---------- ChatGPT export (conversations.json) ----------

export function parseChatGPT(file) {
  const data = JSON.parse(read(file));
  const conversations = Array.isArray(data) ? data : [data];
  const messages = [];
  for (const conv of conversations) {
    const sid = conv.id || conv.conversation_id || conv.title || 'chatgpt';
    const mapping = conv.mapping || {};
    // order nodes by create_time when available
    const nodes = Object.values(mapping).filter((n) => n && n.message);
    nodes.sort((a, b) => (a.message.create_time || 0) - (b.message.create_time || 0));
    for (const n of nodes) {
      const m = n.message;
      const role = m.author && m.author.role;
      if (!role || role === 'system') continue;
      const parts = (m.content && m.content.parts) || [];
      const content = parts.filter((p) => typeof p === 'string').join('\n').trim();
      if (!content) continue;
      messages.push({
        id: m.id || nextId(),
        source: 'chatgpt',
        sessionId: sid,
        role: role === 'tool' ? 'tool' : role,
        content,
        timestamp: m.create_time ? new Date(m.create_time * 1000).toISOString() : null,
        model: (m.metadata && m.metadata.model_slug) || null,
        files: guessFiles(content),
        commits: [],
        diff: null,
      });
    }
  }
  return { project: {}, messages };
}

// ---------- dispatch ----------

const PARSERS = {
  generic: parseGeneric,
  markdown: parseMarkdown,
  aider: parseAider,
  'claude-code': parseClaudeCode,
  chatgpt: parseChatGPT,
};

export function parseSource(source, file) {
  const fn = PARSERS[source];
  if (!fn) throw new Error(`Unknown source "${source}". Known: ${Object.keys(PARSERS).join(', ')}`);
  return fn(file);
}

export const KNOWN_SOURCES = Object.keys(PARSERS);

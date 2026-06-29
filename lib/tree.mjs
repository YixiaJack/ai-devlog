// Tree builder: normalized messages -> a decision tree for rendering.
//
// Layout per the design:
//   Project
//   └── Session
//       └── Idea / Decision   (one per user turn)
//           ├── Prompt        (the user message)
//           ├── Response      (the assistant message)
//           ├── Implementation(files / code / diff)
//           └── Commit        (if any)
//
// A user turn whose prompt contains a "pivot" phrase ("instead", "换个方案",
// "rollback", ...) is rendered as a `decision` branching off the PREVIOUS
// turn, so course-corrections show as real branches rather than a flat list.

let _n = 0;
const nid = () => `n${(++_n).toString(36)}`;

// pivot phrases that signal "change of approach" -> sibling branch
const PIVOT = [
  /\binstead\b/i, /\balternativ/i, /\bactually\b/i, /\brevert\b/i, /\brollback\b/i,
  /\broll back\b/i, /\bundo\b/i, /\bdon'?t (?:do|use)\b/i, /\bscrap\b/i, /\bredo\b/i,
  /换个?(?:方案|思路|方法)/, /改成/, /不要(?:这样|这么)/, /重新/, /其实/, /另一种/, /回退/, /撤销/,
];

// phrases that signal a verification turn
const VERIFY = [/\btest/i, /\bverif/i, /\blint/i, /\bbuild\b/i, /\bci\b/i, /跑(?:测试|一下)/, /验证/, /测试/];

const isPivot = (t) => PIVOT.some((re) => re.test(t));
const isVerify = (t) => VERIFY.some((re) => re.test(t));

export function stripMd(s = '') {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[#>*_~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function title(content, max = 64) {
  const t = stripMd(content).split(/(?<=[.!?。！？])\s/)[0] || stripMd(content);
  return t.length > max ? t.slice(0, max - 1) + '…' : t || '(empty)';
}

export function extractCodeBlocks(content = '') {
  const out = [];
  const re = /```(\w+)?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(content)) !== null) out.push({ lang: m[1] || '', code: m[2].replace(/\n$/, '') });
  return out;
}

function node(type, t, extra = {}) {
  return { id: nid(), type, title: t, summary: '', meta: {}, content: '', codeBlocks: [], diff: null, children: [], ...extra };
}

function promptNode(m) {
  return node('prompt', title(m.content), {
    content: m.content,
    meta: { source: m.source, role: 'user', timestamp: m.timestamp, model: m.model },
    codeBlocks: extractCodeBlocks(m.content),
  });
}

function responseNode(m) {
  return node('response', title(m.content), {
    content: m.content,
    meta: { source: m.source, role: 'assistant', timestamp: m.timestamp, model: m.model },
    codeBlocks: extractCodeBlocks(m.content),
  });
}

function implementationNode(m) {
  const blocks = extractCodeBlocks(m.content);
  const files = m.files || [];
  const body =
    (files.length ? 'Files changed:\n' + files.map((f) => `- \`${f}\``).join('\n') + '\n\n' : '') +
    (m.diff ? '' : blocks.length ? '' : '_no diff captured_');
  return node('implementation', files.length ? files.join(', ') : 'Implementation', {
    content: body,
    diff: m.diff || null,
    codeBlocks: blocks,
    meta: { source: m.source, files, status: m.diff || blocks.length ? 'implemented' : 'open', timestamp: m.timestamp },
  });
}

function commitNode(m) {
  return node('commit', m.commits.join(', '), {
    content: m.commits.map((c) => `commit \`${c}\``).join('\n'),
    meta: { source: m.source, commits: m.commits, timestamp: m.timestamp },
  });
}

export function buildTree(store) {
  _n = 0;
  const root = node('root', store.project?.name || 'AI Devlog', {
    summary: store.project?.remote || store.project?.repoRoot || '',
    meta: { branch: store.project?.branch },
  });

  // group messages by session, preserving first-seen order
  const order = [];
  const groups = new Map();
  for (const m of store.messages) {
    if (!groups.has(m.sessionId)) {
      groups.set(m.sessionId, []);
      order.push(m.sessionId);
    }
    groups.get(m.sessionId).push(m);
  }

  for (const sid of order) {
    const msgs = groups.get(sid);
    const first = msgs[0];
    const sessionTitle = (msgs.find((m) => m.sessionTitle) || {}).sessionTitle || sid;
    const sessionNode = node('session', sessionTitle, {
      summary: `${msgs.length} messages`,
      meta: { source: first.source, timestamp: first.timestamp, branch: store.project?.branch },
    });
    root.children.push(sessionNode);

    let turn = null;
    let lastTurn = null;
    for (const m of msgs) {
      if (m.role === 'user' || m.role === 'system') {
        const pivot = isPivot(m.content);
        const verify = isVerify(m.content) && !pivot;
        const type = pivot ? 'decision' : verify ? 'verification' : 'idea';
        turn = node(type, title(m.content), {
          content: m.content,
          summary: type === 'decision' ? 'branch / course-correction' : '',
          meta: { source: m.source, status: 'open', timestamp: m.timestamp },
        });
        turn.children.push(promptNode(m));
        if (pivot && lastTurn) lastTurn.children.push(turn);
        else sessionNode.children.push(turn);
        lastTurn = turn;
      } else if (m.role === 'assistant') {
        if (!turn) {
          turn = node('idea', title(m.content), { meta: { source: m.source, timestamp: m.timestamp } });
          sessionNode.children.push(turn);
          lastTurn = turn;
        }
        turn.children.push(responseNode(m));
        if ((m.files && m.files.length) || m.diff || extractCodeBlocks(m.content).length) {
          turn.children.push(implementationNode(m));
          turn.meta.status = 'implemented';
        }
        if (m.commits && m.commits.length) turn.children.push(commitNode(m));
      } else if (m.role === 'tool') {
        const t = node('tool', title(m.content), { content: m.content, meta: { source: m.source, timestamp: m.timestamp } });
        (turn || sessionNode).children.push(t);
      }
    }
  }
  if (store.commits && store.commits.length) attachCommits(root, store.commits, store.gitWindowHours || 12);
  return root;
}

function gitCommitNode(c) {
  const body =
    (c.body ? c.body + '\n\n' : '') +
    (c.files && c.files.length ? 'Files:\n' + c.files.map((f) => `- \`${f}\``).join('\n') : '');
  return node('commit', `${c.short} · ${c.subject}`.slice(0, 70), {
    content: body,
    diff: c.diff || null,
    meta: { source: 'git', commits: [c.short], files: c.files || [], timestamp: c.date, status: 'committed', author: c.author },
  });
}

// Correlate each commit to the most recent AI turn that precedes it (within a
// time window). Commits with no nearby turn are grouped under "Unlinked commits".
function attachCommits(root, commits, windowHours) {
  const WINDOW = windowHours * 3600 * 1000;
  // compute a representative time for every node (max timestamp in its subtree)
  (function setTime(n) {
    let t = n.meta && n.meta.timestamp ? Date.parse(n.meta.timestamp) || 0 : 0;
    for (const c of n.children) t = Math.max(t, setTime(c));
    n._time = t;
    return t;
  })(root);

  const turns = [];
  (function collect(n) {
    if (n.type === 'idea' || n.type === 'decision' || n.type === 'verification') turns.push(n);
    n.children.forEach(collect);
  })(root);
  turns.sort((a, b) => a._time - b._time);

  const sorted = [...commits].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const unlinked = [];
  for (const c of sorted) {
    const ct = Date.parse(c.date);
    let best = null;
    for (const t of turns) {
      if (!t._time) continue;
      if (t._time <= ct) best = t; // turns are ascending → keep the closest before ct
      else break;
    }
    if (best && ct - best._time <= WINDOW) {
      best.children.push(gitCommitNode(c));
      best.meta.status = 'committed';
    } else {
      unlinked.push(c);
    }
  }
  if (unlinked.length) {
    const s = node('session', `Unlinked commits (${unlinked.length})`, {
      summary: 'commits with no nearby chat', meta: { source: 'git' },
    });
    unlinked.forEach((c) => s.children.push(gitCommitNode(c)));
    root.children.push(s);
  }
}

// flat stats for the header / filters
export function summarize(root) {
  const types = {};
  const sources = {};
  let count = 0;
  (function walk(n) {
    count++;
    types[n.type] = (types[n.type] || 0) + 1;
    if (n.meta && n.meta.source) sources[n.meta.source] = (sources[n.meta.source] || 0) + 1;
    n.children.forEach(walk);
  })(root);
  return { count, types, sources };
}

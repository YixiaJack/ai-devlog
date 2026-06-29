// Tree builder: normalized messages -> an idea-development tree for rendering.
//
// Only GENUINE human prompts become turns (tool results and injected context
// are filtered out upstream in the parsers). Each prompt is classified by its
// role in developing an idea — IBIS-inspired (Issue -> Position -> Argument):
//
//   goal      a new feature/idea  -> starts a new thread (type: idea)
//   refine    develops that idea  -> nested under the goal
//   fix       reports a problem   -> nested under the goal (type: fix)
//   question  asks rather than directs                    (type: question)
//   verify    asks to test/check                          (type: verification)
//   pivot     "instead / 换个方案" -> branches off the previous turn (type: decision)
//
// Layout:
//   Project
//   └── Session
//       └── Goal (idea)                 one real prompt that introduces a feature
//           ├── Prompt / Response / Implementation / Commit   (its own work)
//           ├── refine / fix / question / verify              (developments of it)
//           └── decision                                      (course-corrections)
//
// All the assistant work between two prompts is merged into ONE response + ONE
// implementation, so the tree reflects human decisions, not raw message spam.

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

// a turn that reports/asks to fix a problem with the current implementation
const FIX = [
  /\b(fix|bug|broken|crash(?:es|ing)?|fails?|failing|not working|doesn'?t work|isn'?t working|wrong|incorrect|regression|error)\b/i,
  /修复|报错|错误|崩溃|失败|不工作|不对|不能用|有问题|坏了|没反应/,
];

// a turn that asks a question rather than directing work
const QUESTION = [
  /^\s*(why|how|what|when|where|which|who|is|are|do|does|can|could|should|would|will)\b[^.!]*\?/i,
  /\?\s*$/, /^\s*(为什么|怎么|如何|是不是|能不能|可以吗|是否|什么是)/, /？\s*$/,
];

// a turn that introduces a new feature / goal (starts a new idea thread)
const NEWGOAL = [
  /^\s*(add|build|create|implement|introduce|set ?up|develop|design|make (?:a|an)|support)\b/i,
  /^\s*(新增|新建|实现|做(?:一)?个|增加|添加|开发|设计|支持)/,
];

const isPivot = (t) => PIVOT.some((re) => re.test(t));
const isVerify = (t) => VERIFY.some((re) => re.test(t));
const isFix = (t) => FIX.some((re) => re.test(t));
const isQuestion = (t) => QUESTION.some((re) => re.test(t));
const isNewGoal = (t) => NEWGOAL.some((re) => re.test(t)) && stripMd(t).length > 22;

// Classify a prompt by its role in developing an idea (IBIS-inspired:
// an Issue/goal, then positions/refinements/arguments that develop it).
function intentOf(content, isFirst) {
  const t = content || '';
  if (isFirst) return 'goal';
  if (isPivot(t)) return 'pivot';
  if (isFix(t)) return 'fix';
  if (isVerify(t)) return 'verify';
  if (isQuestion(t)) return 'question';
  if (isNewGoal(t)) return 'goal';
  return 'refine';
}

const INTENT_TYPE = { goal: 'idea', pivot: 'decision', verify: 'verification', fix: 'fix', refine: 'refine', question: 'question' };

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

    // A "turn" = one real user prompt + ALL the assistant work that follows it
    // until the next prompt. We accumulate that work and emit a single response
    // and a single implementation, instead of one node per raw message.
    let turn = null;
    let lastTurn = null;
    let threadRoot = null; // the current "goal" turn that developments nest under
    let acc = null; // { text:[], files:Set, diffs:[], commits:Set, endTs }

    const finalize = () => {
      if (!turn || !acc) { acc = null; return; }
      const text = acc.text.join('\n\n').trim();
      if (text) {
        turn.children.push(node('response', title(text), {
          content: text.length > 12000 ? text.slice(0, 12000) + '\n\n… (truncated)' : text,
          codeBlocks: extractCodeBlocks(text),
          meta: { source: turn.meta.source, role: 'assistant', timestamp: acc.endTs },
        }));
      }
      const files = [...acc.files];
      if (files.length || acc.diffs.length) {
        turn.children.push(node('implementation', files.length ? files.join(', ') : 'Implementation', {
          content: files.length ? 'Files changed:\n' + files.map((f) => `- \`${f}\``).join('\n') : '',
          diff: acc.diffs.join('\n') || null,
          meta: { source: turn.meta.source, files, status: 'implemented', timestamp: acc.endTs },
        }));
        turn.meta.status = 'implemented';
      }
      for (const c of acc.commits) turn.children.push(commitNode({ commits: [c], source: turn.meta.source }));
      acc = null;
    };

    for (const m of msgs) {
      if (m.role === 'user' || m.role === 'system') {
        finalize();
        const intent = intentOf(m.content, threadRoot === null);
        const type = INTENT_TYPE[intent] || 'idea';
        turn = node(type, title(m.content), {
          content: m.content,
          summary: intent === 'pivot' ? 'course-correction' : intent === 'refine' ? 'develops the idea' : '',
          meta: { source: m.source, status: 'open', timestamp: m.timestamp, intent },
        });
        turn.children.push(promptNode(m));
        // nesting: goals start a new thread; developments nest under the goal;
        // pivots branch off the previous turn and start a new direction.
        if (!threadRoot || intent === 'goal') {
          sessionNode.children.push(turn);
          threadRoot = turn;
        } else if (intent === 'pivot') {
          (lastTurn || threadRoot).children.push(turn);
          threadRoot = turn;
        } else {
          threadRoot.children.push(turn); // refine / fix / question / verify develop the goal
        }
        lastTurn = turn;
        acc = { text: [], files: new Set(), diffs: [], commits: new Set(), endTs: m.timestamp };
      } else if (m.role === 'assistant') {
        if (!turn) { // assistant before any prompt (rare) — open a placeholder turn
          turn = node('idea', '(session start)', { meta: { source: m.source, timestamp: m.timestamp } });
          sessionNode.children.push(turn);
          lastTurn = turn;
          threadRoot = turn;
          acc = { text: [], files: new Set(), diffs: [], commits: new Set(), endTs: m.timestamp };
        }
        if (m.content) acc.text.push(m.content);
        (m.files || []).forEach((f) => acc.files.add(f));
        if (m.diff) acc.diffs.push(m.diff);
        (m.commits || []).forEach((c) => acc.commits.add(c));
        if (m.timestamp) acc.endTs = m.timestamp;
      }
    }
    finalize();
    sessionNode.summary = `${sessionNode.children.length} prompts`;
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

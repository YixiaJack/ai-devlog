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
  return { id: nid(), type, title: t, summary: '', meta: {}, detail: null, children: [], ...extra };
}

// The tree shows IDEAS only. Each idea/turn node carries a `detail` object — the
// full prompt and everything the AI did — which the viewer shows when clicked.
// A node's children are its sub-ideas (refinements, fixes, AI-proposed ideas).

export function buildTree(store) {
  _n = 0;
  const summaries = store.summaries || {};
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
      meta: { source: first.source, timestamp: first.timestamp, branch: store.project?.branch },
    });
    root.children.push(sessionNode);

    // A "turn" = one real user prompt + ALL the assistant work that follows it
    // until the next prompt. The work is merged into the idea node's `detail`.
    let turn = null;
    let lastTurn = null;
    let threadRoot = null; // the current "goal" idea that developments nest under
    let acc = null;

    const finalize = () => {
      if (!turn || !acc) { acc = null; return; }
      const text = acc.text.join('\n\n').trim();
      turn.detail.response = text.length > 16000 ? text.slice(0, 16000) + '\n\n… (truncated)' : text;
      turn.detail.responseTime = acc.endTs;
      turn.detail.files = [...acc.files];
      turn.detail.diff = acc.diffs.join('\n') || null;
      turn.detail.codeBlocks = extractCodeBlocks(text);
      turn.detail.commits.push(...acc.commits);
      if (turn.detail.files.length || turn.detail.diff) turn.meta.status = 'implemented';
      acc = null;
    };

    for (const m of msgs) {
      if (m.role === 'user' || m.role === 'system') {
        finalize();
        const sum = summaries[m.id];
        const intent = intentOf(m.content, threadRoot === null);
        const type = INTENT_TYPE[intent] || 'idea';
        turn = node(type, sum?.ideaTitle || title(m.content), {
          summary: intent === 'pivot' ? 'course-correction' : intent === 'refine' ? 'develops the idea' : '',
          meta: { source: m.source, status: 'open', timestamp: m.timestamp, intent, model: m.model },
          detail: { prompt: m.content, promptTime: m.timestamp, source: m.source,
                    response: '', files: [], diff: null, commits: [], codeBlocks: [] },
        });
        // nesting: goals start a new thread; developments nest under the goal;
        // pivots branch off the previous turn and start a new direction.
        if (!threadRoot || intent === 'goal') {
          sessionNode.children.push(turn);
          threadRoot = turn;
        } else if (intent === 'pivot') {
          (lastTurn || threadRoot).children.push(turn);
          threadRoot = turn;
        } else {
          threadRoot.children.push(turn);
        }
        // AI-proposed ideas (from the LLM summarizer) become child idea nodes
        if (sum?.aiIdeas?.length) {
          for (const ai of sum.aiIdeas) {
            turn.children.push(node('ai-idea', ai, {
              meta: { source: 'ai', timestamp: m.timestamp },
              detail: { aiProposed: true, context: turn.title },
            }));
          }
        }
        lastTurn = turn;
        acc = { text: [], files: new Set(), diffs: [], commits: new Set(), endTs: m.timestamp };
      } else if (m.role === 'assistant') {
        if (!turn) { // assistant before any prompt (rare) — open a placeholder idea
          turn = node('idea', '(session start)', {
            meta: { source: m.source, timestamp: m.timestamp },
            detail: { prompt: '', response: '', files: [], diff: null, commits: [], codeBlocks: [] },
          });
          sessionNode.children.push(turn);
          lastTurn = turn;
          threadRoot = turn;
          acc = { text: [], files: new Set(), diffs: [], commits: new Set(), endTs: m.timestamp };
        }
        if (m.content) acc.text.push(m.content);
        (m.files || []).forEach((f) => acc.files.add(f));
        if (m.diff) acc.diffs.push(m.diff);
        (m.commits || []).forEach((c) => acc.commits.add({ short: c }));
        if (m.timestamp) acc.endTs = m.timestamp;
      }
    }
    finalize();
    sessionNode.summary = `${sessionNode.children.length} ideas`;
  }

  if (store.commits && store.commits.length) attachCommits(root, store.commits, store.gitWindowHours || 12);
  return root;
}

// Correlate each commit to the most recent AI idea that precedes it (within a
// time window). Commits fold into that idea's detail. Leftovers go under an
// "Unlinked commits" session node.
function attachCommits(root, commits, windowHours) {
  const WINDOW = windowHours * 3600 * 1000;
  (function setTime(n) {
    let t = n.meta && n.meta.timestamp ? Date.parse(n.meta.timestamp) || 0 : 0;
    if (n.detail && n.detail.responseTime) t = Math.max(t, Date.parse(n.detail.responseTime) || 0);
    for (const c of n.children) t = Math.max(t, setTime(c));
    n._time = t;
    return t;
  })(root);

  const TURN = { idea: 1, refine: 1, fix: 1, question: 1, decision: 1, verification: 1 };
  const turns = [];
  (function collect(n) {
    if (TURN[n.type]) turns.push(n);
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
      if (t._time <= ct) best = t;
      else break;
    }
    if (best && ct - best._time <= WINDOW) {
      best.detail.commits.push(c);
      best.meta.status = 'committed';
    } else {
      unlinked.push(c);
    }
  }
  if (unlinked.length) {
    root.children.push(node('session', `Unlinked commits (${unlinked.length})`, {
      summary: 'commits with no nearby chat',
      meta: { source: 'git' },
      detail: { unlinkedCommits: unlinked },
    }));
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

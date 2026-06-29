// Optional LLM layer — organizes each session's prompts into a deep idea tree:
// a concise title + kind + PARENT for every idea (so ideas nest under one
// another, not as a flat peer list), plus ideas the AI proposed.
//
// Drives the headless Claude Code CLI (the user's subscription) rather than the
// API — no key, no SDK. Results cache in store.summaries keyed by message id.

import { spawn } from 'node:child_process';

export const DEFAULT_MODEL = 'haiku';

const INSTRUCTIONS = `You organize one AI pair-programming session into an IDEA TREE.
You get an ordered list of turns: {id, prompt, ai} where "ai" is a short note of what the assistant did.
Return STRICT JSON only (no prose, no code fence):
{"items":[{"id":"<same id>","title":"<concise idea, <=8 words, same language as prompt, no quotes>","kind":"goal|refine|fix|question|decision|verify","parentId":"<id of an EARLIER turn this idea develops/belongs under, or null>","aiIdeas":["<idea the assistant proposed, <=8 words>"]}]}
Rules:
- A session has MANY ideas and they are usually NOT siblings. Nest each idea under the specific earlier idea it refines, fixes, answers, or follows from. Use null only for genuinely new top-level ideas.
- kind: goal=new feature/topic, refine=develops it, fix=reports a problem, question=asks, decision=changes approach/pivot, verify=test/build/check.
- aiIdeas: 0-3 distinct ideas the assistant proposed beyond the literal request; [] if none.
- One item per input id, same ids.`;

function runClaude({ prompt, model, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
    // single command string (no args array) so shell:true doesn't warn; model is
    // sanitized. shell:true resolves the `claude` shim on Windows + POSIX.
    const safeModel = model && /^[\w.\-]+$/.test(model) ? model : '';
    const cmd = 'claude -p --output-format json' + (safeModel ? ' --model ' + safeModel : '');
    const ch = spawn(cmd, { shell: true });
    let out = '', err = '';
    const timer = setTimeout(() => { ch.kill(); reject(new Error('claude timed out')); }, timeoutMs);
    ch.stdout.on('data', (d) => (out += d));
    ch.stderr.on('data', (d) => (err += d));
    ch.on('error', (e) => { clearTimeout(timer); reject(e); });
    ch.on('close', (code) => {
      clearTimeout(timer);
      try {
        const env = JSON.parse(out);
        if (env.is_error) return reject(new Error('claude: ' + String(env.result || '').slice(0, 200)));
        resolve(env.result || '');
      } catch {
        reject(new Error(code !== 0 ? `claude exited ${code}: ${err.slice(0, 200)}` : `bad output: ${out.slice(0, 200)}`));
      }
    });
    ch.stdin.write(prompt);
    ch.stdin.end();
  });
}

function parseJson(text) {
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

function sessionsOf(store) {
  const groups = new Map();
  for (const m of store.messages) {
    if (!groups.has(m.sessionId)) groups.set(m.sessionId, []);
    groups.get(m.sessionId).push(m);
  }
  // for each session: ordered turns [{lid, msgId, prompt, ai}]
  const out = [];
  for (const [sid, msgs] of groups) {
    const turns = [];
    let cur = null;
    for (const m of msgs) {
      if (m.role === 'user' || m.role === 'system') {
        if (cur) turns.push(cur);
        cur = { msgId: m.id, prompt: (m.content || '').slice(0, 700), ai: '' };
      } else if (m.role === 'assistant' && cur && m.content && cur.ai.length < 400) {
        cur.ai = (cur.ai + ' ' + m.content).slice(0, 400);
      }
    }
    if (cur) turns.push(cur);
    turns.forEach((t, i) => (t.lid = 't' + (i + 1)));
    if (turns.length) out.push({ sid, turns });
  }
  return out;
}

export async function summarize(store, { model = DEFAULT_MODEL, limit = 0, log = () => {} } = {}) {
  store.summaries = store.summaries || {};
  let sessions = sessionsOf(store).filter((s) => s.turns.some((t) => !store.summaries[t.msgId]));
  if (limit > 0) sessions = sessions.slice(0, limit);
  if (!sessions.length) { log('All sessions already summarized.'); return store; }

  let i = 0;
  for (const s of sessions) {
    i++;
    const idToMsg = {};
    s.turns.forEach((t) => (idToMsg[t.lid] = t.msgId));
    const payload = s.turns.map((t) => ({ id: t.lid, prompt: t.prompt, ai: t.ai }));
    const prompt = INSTRUCTIONS + '\n\nTURNS:\n' + JSON.stringify(payload);
    try {
      const items = (parseJson(await runClaude({ prompt, model })).items) || [];
      const byLid = {};
      for (const it of items) byLid[it.id] = it;
      for (const t of s.turns) {
        const it = byLid[t.lid];
        if (!it) continue;
        const parentLid = it.parentId && it.parentId !== t.lid ? it.parentId : null;
        store.summaries[t.msgId] = {
          ideaTitle: it.title || '',
          kind: it.kind || 'idea',
          parentId: parentLid && idToMsg[parentLid] ? idToMsg[parentLid] : null,
          aiIdeas: Array.isArray(it.aiIdeas) ? it.aiIdeas.slice(0, 3) : [],
        };
      }
      log(`  [${i}/${sessions.length}] ${s.turns.length} ideas — ${s.sid.slice(0, 40)}`);
    } catch (e) {
      log(`  [${i}/${sessions.length}] failed (${e.message}); keeping heuristic for this session.`);
    }
  }
  return store;
}

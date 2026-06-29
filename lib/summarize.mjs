// Optional LLM layer — arranges the WHOLE project's ideas into one tree by
// structure + time: a concise title + kind + PARENT for every idea (so ideas
// nest under one another across the whole history, not grouped by session),
// plus ideas the AI proposed.
//
// Drives the headless Claude Code CLI (the user's subscription) rather than the
// API — no key, no SDK. Results cache in store.summaries keyed by message id.

import { spawn } from 'node:child_process';

export const DEFAULT_MODEL = 'haiku';

const INSTRUCTIONS = `You arrange a developer's AI-coding history into ONE idea tree.
You get ideas in TIME ORDER, each {id, prompt, ai} (ai = short note of what the assistant did). You may also get PRIOR ideas already placed ({id, title}); you may parent new ideas onto those.
Return STRICT JSON only (no prose, no code fence):
{"items":[{"id":"<same id>","title":"<concise idea, <=8 words, same language as prompt, no quotes>","kind":"goal|refine|fix|question|decision|verify","parentId":"<id of an EARLIER idea this one develops/belongs under, or null>","aiIdeas":["<idea the assistant proposed, <=8 words>"]}]}
Rules:
- Build ONE tree for the whole project. Ideas are usually NOT siblings — nest each idea under the specific earlier idea it refines, fixes, answers, or follows from, by meaning, even if that earlier idea came much earlier. Use null only for genuinely new top-level themes.
- kind: goal=new feature/topic, refine=develops it, fix=reports a problem, question=asks, decision=changes approach/pivot, verify=test/build/check.
- aiIdeas: 0-3 distinct ideas the assistant proposed beyond the literal request; [] if none.
- One item per CURRENT id, same ids. parentId may reference a CURRENT id or a PRIOR id.`;

function runClaude({ prompt, model, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
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

// All real prompts across the project, in global time order.
function allTurns(store) {
  const groups = new Map();
  for (const m of store.messages) {
    if (!groups.has(m.sessionId)) groups.set(m.sessionId, []);
    groups.get(m.sessionId).push(m);
  }
  const turns = [];
  for (const msgs of groups.values()) {
    let cur = null;
    for (const m of msgs) {
      if (m.role === 'user' || m.role === 'system') {
        if (cur) turns.push(cur);
        cur = { msgId: m.id, time: Date.parse(m.timestamp) || 0, prompt: (m.content || '').slice(0, 500), ai: '' };
      } else if (m.role === 'assistant' && cur && m.content && cur.ai.length < 250) {
        cur.ai = (cur.ai + ' ' + m.content).slice(0, 250);
      }
    }
    if (cur) turns.push(cur);
  }
  turns.sort((a, b) => a.time - b.time);
  return turns;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function summarize(store, { model = DEFAULT_MODEL, limit = 0, chunkSize = 30, log = () => {} } = {}) {
  store.summaries = store.summaries || {};
  const turns = allTurns(store);
  turns.forEach((t, i) => (t.gid = 'g' + (i + 1)));
  const gidToMsg = {}; turns.forEach((t) => (gidToMsg[t.gid] = t.msgId));

  let todo = turns.filter((t) => !store.summaries[t.msgId]);
  if (limit > 0) todo = todo.slice(0, limit);
  if (!todo.length) { log('All ideas already arranged.'); return store; }

  const chunks = chunk(todo, chunkSize);
  let i = 0;
  for (const c of chunks) {
    i++;
    // context = ideas already placed (this run + prior runs), id + title only
    const prior = turns.filter((t) => store.summaries[t.msgId])
      .slice(-80).map((t) => ({ id: t.gid, title: store.summaries[t.msgId].ideaTitle }));
    const payload = { priorIdeas: prior, ideas: c.map((t) => ({ id: t.gid, prompt: t.prompt, ai: t.ai })) };
    const prompt = INSTRUCTIONS + '\n\n' + JSON.stringify(payload);
    try {
      const items = (parseJson(await runClaude({ prompt, model })).items) || [];
      const byGid = {};
      for (const it of items) byGid[it.id] = it;
      for (const t of c) {
        const it = byGid[t.gid];
        if (!it) continue;
        const pg = it.parentId && it.parentId !== t.gid ? it.parentId : null;
        store.summaries[t.msgId] = {
          ideaTitle: it.title || '',
          kind: it.kind || 'idea',
          parentId: pg && gidToMsg[pg] ? gidToMsg[pg] : null,
          aiIdeas: Array.isArray(it.aiIdeas) ? it.aiIdeas.slice(0, 3) : [],
        };
      }
      log(`  [${i}/${chunks.length}] arranged ${c.length} ideas`);
    } catch (e) {
      log(`  [${i}/${chunks.length}] failed (${e.message}); keeping heuristic for these.`);
    }
  }
  return store;
}

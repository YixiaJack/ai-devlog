// Optional LLM layer — arranges the WHOLE project's ideas into one tree by
// structure + time: a concise title + kind + PARENT for every idea (so ideas
// nest under one another across the whole history, not grouped by session),
// plus ideas the AI proposed.
//
// Drives the headless Claude Code CLI (the user's subscription) rather than the
// API — no key, no SDK. Results cache in store.summaries keyed by message id.

import { spawn } from 'node:child_process';

export const DEFAULT_MODEL = 'haiku';

const INSTRUCTIONS = `You arrange a developer's AI-coding history into ONE clear, well-structured idea tree, BILINGUAL (English + Chinese).
You get ideas in TIME ORDER, each {id, prompt, ai} (ai = short note of what the assistant did). You also get CATEGORIES already in use (English names) and PRIOR ideas already placed ({id, titleEn}).
Return STRICT JSON only (no prose, no code fence):
{"items":[{"id":"<same id>","titleEn":"<the idea in English, <=8 words, no quotes>","titleZh":"<同一个想法的中文, <=14字>","kind":"goal|refine|fix|question|decision|verify","categoryEn":"<category, 1-3 words>","categoryZh":"<分类中文>","parentId":"<id of an EARLIER idea this develops/belongs under, or null>","aiIdeas":[{"en":"<idea in English>","zh":"<中文>"}]}]}
Rules:
1. PHRASE TITLES AS IDEAS, not as commands or steps. Capture the concept / intent / decision behind the turn. Prefer "Refresh-token rotation for sessions" over "Add refresh tokens"; "Synchronized PDF/notes scrolling" over "Fix scroll"; "Is the app secure?" over "Run audit". titleEn and titleZh MUST mean the same thing; provide BOTH for every item regardless of the prompt's language.
2. CLASSIFY: put every idea into a high-level CATEGORY (feature area / theme). Keep the WHOLE project to between 3 and 7 categories total. Reuse a CATEGORIES name when it fits; only invent a new short category when truly needed.
3. NEST: ideas are usually NOT siblings. Parent each idea under the specific earlier idea it refines, fixes, answers, or follows from — by meaning, even across time. parentId null only for a genuinely new top-level idea within its category.
4. kind: goal=new feature/topic, refine=develops it, fix=reports a problem, question=asks, decision=changes approach/pivot, verify=test/build/check.
5. aiIdeas = the genuine INSIGHTS the assistant contributed that are worth remembering and that the user did NOT explicitly ask for. Return 0-3 (many turns have none). INCLUDE any of:
   - a design decision, non-obvious approach, alternative, or tradeoff ("header auth instead of query string");
   - a FINDING from the assistant's research / web search ("competitor uses invite-only waitlist", "Bilibili download needs a Referer header");
   - a RECOMMENDATION or learned constraint ("rotate the key after pasting", "prefer RAG over full-text for quizzes");
   - a useful comparison or rationale that shaped a choice.
   EXCLUDE (NOT insights — raw data or mechanics): running or fixing tests, editing a file, applying a patch; a bare metric or error number with no implication; a routine bug diagnosis; restating the request; or step-by-step "how I did it". An insight answers "what does this mean / why it matters", not "what was done".
- One item per CURRENT id, same ids. parentId may reference a CURRENT or PRIOR id.`;

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
      } else if (m.role === 'assistant' && cur && m.content && cur.ai.length < 4000) {
        cur.ai = (cur.ai + '\n' + m.content).slice(0, 4000);
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

// Conclusions/recommendations live at the END of a long response — keep the
// head (intent) and the tail (findings/recommendations).
function aiSnippet(s) {
  s = (s || '').trim();
  if (s.length <= 1500) return s;
  return s.slice(0, 700) + ' […] ' + s.slice(-800);
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
    // context = categories so far + ideas already placed (id + English title)
    const placed = turns.filter((t) => store.summaries[t.msgId]);
    const cats = [...new Set(placed.map((t) => store.summaries[t.msgId].categoryEn).filter(Boolean))];
    const prior = placed.slice(-80).map((t) => ({ id: t.gid, titleEn: store.summaries[t.msgId].titleEn }));
    const payload = { categories: cats, priorIdeas: prior, ideas: c.map((t) => ({ id: t.gid, prompt: t.prompt, ai: aiSnippet(t.ai) })) };
    const prompt = INSTRUCTIONS + '\n\n' + JSON.stringify(payload);
    try {
      const items = (parseJson(await runClaude({ prompt, model })).items) || [];
      const byGid = {};
      for (const it of items) byGid[it.id] = it;
      for (const t of c) {
        const it = byGid[t.gid];
        if (!it) continue;
        const pg = it.parentId && it.parentId !== t.gid ? it.parentId : null;
        const ai = (Array.isArray(it.aiIdeas) ? it.aiIdeas : []).slice(0, 3)
          .map((x) => (typeof x === 'string' ? { en: x, zh: x } : { en: x.en || x.zh || '', zh: x.zh || x.en || '' }))
          .filter((x) => x.en || x.zh);
        store.summaries[t.msgId] = {
          titleEn: it.titleEn || it.titleZh || '',
          titleZh: it.titleZh || it.titleEn || '',
          kind: it.kind || 'idea',
          categoryEn: (it.categoryEn || '').trim() || 'General',
          categoryZh: (it.categoryZh || '').trim() || (it.categoryEn || '').trim() || '通用',
          parentId: pg && gidToMsg[pg] ? gidToMsg[pg] : null,
          aiIdeas: ai,
        };
      }
      log(`  [${i}/${chunks.length}] arranged ${c.length} ideas`);
    } catch (e) {
      log(`  [${i}/${chunks.length}] failed (${e.message}); keeping heuristic for these.`);
    }
  }
  return store;
}

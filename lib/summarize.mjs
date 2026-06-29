// Optional LLM layer: turn each real prompt (+ what the AI did) into a concise
// idea label, and extract distinct ideas the AI proposed. Results are cached in
// store.summaries keyed by the user message id, so re-runs only do new turns.
//
// Uses the Claude Messages API over plain fetch (no SDK) to keep ai-devlog
// dependency-free. Opt-in: needs ANTHROPIC_API_KEY. Default model: Haiku
// (cheap, fits bulk summarization); override with --model.

const API_URL = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_MODEL = 'claude-haiku-4-5';

const SYSTEM = `You label turns from an AI pair-programming chat to build an "idea tree".
You receive an array of turns, each {id, prompt, response}. For each turn return:
- ideaTitle: a concise label (<= 8 words) for what the USER wants in this turn, in the SAME language as the prompt, no trailing punctuation, no quotes.
- aiIdeas: 0-3 short phrases (<= 8 words each) naming DISTINCT ideas, approaches, or suggestions the ASSISTANT proposed that go beyond the literal request. Return an empty array if the assistant just did what was asked.
Return one item per input id, same ids.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'ideaTitle', 'aiIdeas'],
        properties: {
          id: { type: 'string' },
          ideaTitle: { type: 'string' },
          aiIdeas: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

// Build one summarization unit per real user prompt: the prompt + the assistant
// text that follows it until the next prompt (truncated to keep tokens low).
function collectTurns(store) {
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
        cur = { id: m.id, prompt: (m.content || '').slice(0, 1500), response: '' };
      } else if (m.role === 'assistant' && cur && m.content) {
        if (cur.response.length < 1800) cur.response = (cur.response + '\n' + m.content).slice(0, 1800);
      }
    }
    if (cur) turns.push(cur);
  }
  return turns;
}

async function callClaude({ apiKey, model, batch }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(batch) }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('Could not parse model JSON output'); }
  return parsed.items || [];
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function summarize(store, { apiKey, model = DEFAULT_MODEL, batchSize = 8, limit = 0, log = () => {} } = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Summarization needs an API key.');
  store.summaries = store.summaries || {};
  let todo = collectTurns(store).filter((t) => !store.summaries[t.id]);
  if (limit > 0) todo = todo.slice(0, limit);
  if (!todo.length) { log('All turns already summarized.'); return store; }

  const batches = chunk(todo, batchSize);
  let done = 0;
  for (const batch of batches) {
    try {
      const items = await callClaude({ apiKey, model, batch });
      const byId = {};
      for (const it of items) byId[it.id] = it;
      for (const t of batch) {
        const it = byId[t.id];
        if (it) store.summaries[t.id] = { ideaTitle: it.ideaTitle, aiIdeas: (it.aiIdeas || []).slice(0, 3) };
      }
    } catch (e) {
      log(`  batch failed (${e.message}); keeping heuristic titles for these.`);
    }
    done += batch.length;
    log(`  summarized ${done}/${todo.length}`);
  }
  return store;
}

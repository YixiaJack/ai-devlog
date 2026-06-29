# ai-devlog

**Turn AI coding chats (IDE / CLI / Web) into an interactive idea tree — exported as a clean, self-contained HTML document.**

Not another chat exporter. ai-devlog aggregates conversations from multiple
sources and distills them into a **tree of ideas**: each node is one real idea
(a goal, refinement, fix, question, pivot, or an idea the AI proposed).
**Click a node** to reveal the full prompt and exactly what the AI did in
response (its answer, the files it changed, diffs, and the git commits that
landed). Optionally, an LLM labels each idea node concisely. The output is a
single offline HTML file you can pan, zoom, search, and share.

> "把 AI 编程聊天变成项目的可审计决策树：每个 prompt、每次分叉、每个实现、每个 diff 都能追溯。"

## Why

Traditional diffs tell you *what* changed; they lose *why*. ai-devlog keeps the
reasoning — every prompt, every pivot, every implementation — as a structured tree.

## Quick start

No dependencies. Requires Node 18+.

```bash
# see it immediately with built-in sample data
node ai-devlog.mjs demo
# → open ai-history-export/index.html in any browser
```

## Auto-discover your real history (Claude Code + Codex)

ai-devlog knows where these CLIs store sessions and finds them for you — no need
to hunt for file paths:

- **Claude Code** → `~/.claude/projects/<encoded-cwd>/*.jsonl`
- **Codex CLI** → `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`

```bash
cd /path/to/your/project
node /path/to/ai-devlog.mjs discover        # list this project's local sessions
node /path/to/ai-devlog.mjs auto            # import them all + build the HTML
node /path/to/ai-devlog.mjs auto --all      # every project on this machine
node /path/to/ai-devlog.mjs auto --project C:/code/my-app --out ./report
```

`auto` matches sessions to your project by their recorded `cwd`. Web chats
(ChatGPT / Claude web) have no local session file, so those stay manual upload.

## LLM idea labels (optional)

By default, idea node labels come from a heuristic (the first line of the
prompt). With an API key, an LLM rewrites each into a concise idea and also
extracts **ideas the AI proposed** (which become their own nodes):

```bash
export ANTHROPIC_API_KEY=sk-ant-…
node ai-devlog.mjs auto --git --summarize          # discover + git + LLM labels, one shot
# or on an existing store:
node ai-devlog.mjs summarize --model claude-haiku-4-5
node ai-devlog.mjs export
```

Calls the Claude Messages API directly (no SDK, stays dependency-free), batched
and cached in the store so re-runs only label new turns. Default model is Haiku
(cheap for bulk summarizing); override with `--model`. This is the only step
that sends data off your machine — everything else is local.

## Correlate git commits (the "why" behind each diff)

Point ai-devlog at the project's git history and it attaches each commit — with
its diff — to the **nearest preceding AI turn**, so a prompt now links straight
to the code that landed:

```bash
node ai-devlog.mjs auto --git                       # discover chats + correlate commits, in one shot
# or, on an existing store:
node ai-devlog.mjs scan-git --since "30 days ago"
node ai-devlog.mjs export
```

- Matching uses commit time vs. message time, within a window (default **12h**,
  override with `--window <hours>`).
- Commits with no nearby chat are grouped under an **"Unlinked commits"** node,
  so nothing is silently dropped.
- Diffs are captured per commit (bulk commits touching >30 files keep the file
  list but skip the patch, to keep the HTML lean).

## Manual import (web exports & others)

```bash
node ai-devlog.mjs init
node ai-devlog.mjs import --source chatgpt     conversations.json
node ai-devlog.mjs import --source aider       .aider.chat.history.md
node ai-devlog.mjs import --source generic     my-export.json
node ai-devlog.mjs export ./ai-history-export
```

### Supported sources

| `--source`     | Input                                   | Auto? | Notes |
|----------------|-----------------------------------------|:-----:|-------|
| `claude-code`  | Claude Code session `*.jsonl`           |  ✅   | text + `tool_use` file edits; session title from `aiTitle` |
| `codex`        | Codex `rollout-*.jsonl`                  |  ✅   | messages + `apply_patch` diffs; skips injected instructions |
| `chatgpt`      | ChatGPT export `conversations.json`     |  —    | walks the message `mapping` graph |
| `aider`        | `.aider.chat.history.md`                |  —    | `####` = user turns, rest = assistant |
| `markdown`     | any markdown with role headings         |  —    | `## User` / `### Assistant` … |
| `generic`      | JSON in ai-devlog's own schema          |  —    | full control (timestamps, diffs, commits) |

### `generic` schema

```json
{
  "project": { "name": "my-app", "remote": "git@github.com:org/my-app.git", "branch": "main" },
  "messages": [
    { "source": "cursor", "sessionId": "auth", "role": "user", "content": "Add JWT refresh" },
    { "source": "cursor", "sessionId": "auth", "role": "assistant",
      "content": "Done.", "files": ["src/auth.ts"], "commits": ["abc123"],
      "diff": "@@ src/auth.ts @@\n- old\n+ new" }
  ]
}
```

## How the tree is built

**Only genuine human prompts become nodes.** This matters: in a Claude Code
session, the vast majority of `type:"user"` lines are *tool results*, IDE
notifications (`<ide_opened_file>`), task notifications and injected system
reminders — not things you typed. ai-devlog filters all of that out (and drops
Codex's `developer`/permissions instructions), so the prompt count reflects
real interactions, not message spam.

Each real prompt is then classified by its **role in developing an idea** —
[IBIS](https://en.wikipedia.org/wiki/Issue-based_information_system)-inspired
(Issue → Position → Argument):

| type | meaning | placement |
|------|---------|-----------|
| `idea` (goal) | introduces a feature/goal | starts a new thread |
| `refine` | develops the current goal | nested under the goal |
| `fix` | reports a problem (`bug`, `报错`, `broken`, …) | nested under the goal |
| `question` | asks rather than directs (`why…?`, `为什么`) | nested under the goal |
| `verification` | asks to test/build/lint | nested under the goal |
| `decision` | a pivot (`instead`, `actually`, `换个方案`, `改成`) | **branches off** the previous turn |
| `ai-idea` | an idea the AI proposed (LLM-extracted) | nested under the turn it came from |

**The tree is ideas only.** Each idea node carries the full prompt and all the
assistant work that followed it (merged into one answer + the files/diffs/commits)
as `detail` — shown when you click the node, not as separate tree nodes. With
`--git`, the real commit + diff is folded into the nearest idea's detail.

## The HTML output

`export` writes a **single self-contained `index.html`** (CSS + JS + data all
inlined) plus `data/devlog.json` for reuse. The page works offline via
`file://` — nothing is uploaded. The whole UI is the **idea tree**:

- **Canvas** — a pan/zoom node-link tree (drag to pan, scroll to zoom). Nodes
  are color-coded ideas; user-originated ideas are marked 🧑, AI-proposed ideas
  💡. Click a node's `+N` to expand its sub-ideas.
- **Click a node** → a side drawer reveals the full **prompt** and **what the AI
  did**: its answer (rendered markdown + code), files changed, unified diff
  (red/green), and the correlated git commits.
- **Search** (top) filters the tree to matching ideas/prompts/code and their
  ancestors.

All prompt/response content is HTML-escaped before rendering (prompts can
contain arbitrary HTML/JS), and links are restricted to `http(s)/mailto/relative`.
The tree layout and click-to-detail follow the canonical
[D3 collapsible-tree](https://observablehq.com/@d3/collapsible-tree) pattern,
implemented in self-contained SVG (no CDN).

## Run it as a command

It's a plain Node script, so there are three ways to use it:

```bash
# 1. clone + run directly (works today, no install)
git clone https://github.com/YixiaJack/ai-devlog
node ai-devlog/ai-devlog.mjs auto

# 2. install globally from the clone → use `ai-devlog` anywhere
cd ai-devlog && npm install -g .
ai-devlog auto

# 3. run straight from GitHub without cloning
npx github:YixiaJack/ai-devlog auto
```

To get a bare `npx ai-devlog` (no `github:` prefix), publish it to the npm
registry: `npm login && npm publish`.

## Privacy

Local-first and read-only: ai-devlog reads files you point it at and writes a
static folder. It never uploads anything. Redact secrets in your exports before
sharing.

## Project layout

```
ai-devlog.mjs        CLI (auto / discover / scan-git / summarize / import / export / demo)
lib/discover.mjs     find local Claude Code + Codex sessions
lib/git.mjs          read git commits/diffs for correlation
lib/summarize.mjs    optional LLM idea labels + AI-proposed ideas (Claude API)
lib/parsers.mjs      source → normalized messages
lib/tree.mjs         messages → idea tree (intent classify, nest, commit correlation)
lib/exporter.mjs     tree → single self-contained HTML
lib/sample.mjs       demo data
template/            index.html · style.css · app.js (SVG tree canvas; inlined on export)
test/dom-smoke.mjs   headless render + click→drawer smoke test
```

## Roadmap

Cursor SQLite reader · richer LLM clustering of ideas into themes ·
lazy-rendered tree for very large histories · MCP server exposing the history
as queryable resources.

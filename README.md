# ai-devlog

**Turn AI coding chats (IDE / CLI / Web) into an auditable decision tree — exported as a clean, self-contained HTML document.**

Not another chat exporter. ai-devlog aggregates conversations from multiple
sources, then organizes them into **idea → prompt → AI response → implementation
→ diff → commit**, with course-corrections shown as **branches**. The output is
a single offline HTML file you can search, expand, and share.

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

- Each **user turn** becomes an `idea` node holding its `prompt`, the AI
  `response`, an `implementation` (files / code / diff), and any `commit`.
- A prompt containing a **pivot phrase** (`instead`, `actually`, `rollback`,
  `换个方案`, `改成`, `不要这样`, …) becomes a **`decision`** that branches off
  the *previous* turn — so course-corrections are visible as real branches.
- A prompt about tests/build/lint becomes a **`verification`** node.

## The HTML output

`export` writes a **single self-contained `index.html`** (CSS + JS + data all
inlined) plus `data/devlog.json` for reuse. The page works offline via
`file://` — nothing is uploaded.

- **Left** — filter by node type and source.
- **Center** — the collapsible decision tree, color-coded by node type.
- **Right** — full prompt / response (rendered markdown), code blocks, unified
  diff (red/green), files and commits.
- **Top** — full-text search across prompts, ideas, and code.

All prompt/response content is HTML-escaped before rendering (prompts can
contain arbitrary HTML/JS), and links are restricted to `http(s)/mailto/relative`.

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
ai-devlog.mjs        CLI (auto / discover / scan-git / import / export / demo)
lib/discover.mjs     find local Claude Code + Codex sessions
lib/git.mjs          read git commits/diffs for correlation
lib/parsers.mjs      source → normalized messages
lib/tree.mjs         messages → decision tree (+ branch & commit correlation)
lib/exporter.mjs     tree → single self-contained HTML
lib/sample.mjs       demo data
template/            index.html · style.css · app.js (inlined on export)
test/dom-smoke.mjs   headless render smoke test
```

## Roadmap

Cursor SQLite reader · AI summarization layer (idea/decision extraction) ·
lazy-rendered tree for very large histories · MCP server exposing the history
as queryable resources.

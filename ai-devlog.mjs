#!/usr/bin/env node
// ai-devlog — turn AI coding chats into an auditable decision tree (static HTML).
import fs from 'node:fs';
import path from 'node:path';
import { parseSource, KNOWN_SOURCES } from './lib/parsers.mjs';
import { buildTree, summarize as summarizeStats } from './lib/tree.mjs';
import { exportHtml } from './lib/exporter.mjs';
import { sampleStore } from './lib/sample.mjs';
import { discover } from './lib/discover.mjs';
import { gitCommits, isGitRepo } from './lib/git.mjs';
import { summarize, DEFAULT_MODEL } from './lib/summarize.mjs';

const STORE = '.ai-devlog/store.json';

function loadStore() {
  if (fs.existsSync(STORE)) return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  return { project: {}, messages: [] };
}
function saveStore(s) {
  fs.mkdirSync('.ai-devlog', { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(s, null, 2));
}
function payloadFrom(store) {
  const tree = buildTree(store);
  return { tree, stats: summarizeStats(tree), generatedFrom: store.project };
}

// crude flag parser: --key value
function flags(argv) {
  const f = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { f[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    else rest.push(argv[i]);
  }
  return { f, rest };
}

const cmd = process.argv[2];
const { f, rest } = flags(process.argv.slice(3));

function help() {
  console.log(`ai-devlog — AI coding chats → decision-tree HTML

Usage:
  ai-devlog auto [--project <dir>] [--all] [--git] [--out <dir>]
                                               auto-find Claude Code + Codex sessions, import, export
  ai-devlog discover [--project <dir>] [--all] list local sessions without importing
  ai-devlog scan-git [--project <dir>] [--since <date>] [--window <hours>]
                                               attach git commits/diffs to turns by time
  ai-devlog summarize [--model <id>] [--limit N]
                                               LLM idea hierarchy + labels via the claude CLI (no API key)
  ai-devlog init
  ai-devlog import --source <type> <file>     sources: ${KNOWN_SOURCES.join(', ')}
  ai-devlog build
  ai-devlog export [outDir]                    default: ./ai-history-export
  ai-devlog demo [outDir]                      generate sample data + export

Examples:
  ai-devlog auto --git                         # chat history + correlated git commits
  ai-devlog auto --all                         # every project on this machine
  ai-devlog import --source chatgpt conversations.json   # web exports stay manual
  ai-devlog scan-git --since "30 days ago"     # then: ai-devlog export

--project defaults to the current directory. --all ignores project matching.
--git correlates each commit to the nearest preceding AI turn (default window 12h).
`);
}

try {
  switch (cmd) {
    case 'init': {
      const s = loadStore();
      saveStore(s);
      console.log(`Initialized ${STORE}`);
      break;
    }
    case 'import': {
      const file = rest[0];
      if (!f.source || !file) { console.error('need --source <type> <file>'); process.exit(1); }
      const parsed = parseSource(f.source, file);
      const store = loadStore();
      store.project = { ...parsed.project, ...store.project, ...(Object.keys(store.project).length ? {} : parsed.project) };
      if (!store.project.name) store.project.name = path.basename(process.cwd());
      store.messages.push(...parsed.messages);
      saveStore(store);
      console.log(`Imported ${parsed.messages.length} messages from ${f.source} (${path.basename(file)}). Total: ${store.messages.length}`);
      break;
    }
    case 'scan-git': {
      const store = loadStore();
      const repo = f.project || store.project.repoRoot || process.cwd();
      if (!isGitRepo(repo)) { console.error(`Not a git repo: ${repo}`); process.exit(1); }
      store.commits = gitCommits(repo, { since: f.since });
      if (!store.project.repoRoot) store.project.repoRoot = repo;
      if (f.window) store.gitWindowHours = Number(f.window);
      saveStore(store);
      console.log(`Scanned ${store.commits.length} commits from ${repo}${f.since ? ` (since ${f.since})` : ''}. Run \`export\` to build.`);
      break;
    }
    case 'build': {
      const store = loadStore();
      const stats = summarizeStats(buildTree(store));
      console.log(`Built tree: ${stats.count} nodes`, stats.types);
      break;
    }
    case 'summarize': {
      const store = loadStore();
      if (!store.messages.length) { console.error('No messages. Import first.'); process.exit(1); }
      if (f.refresh) { store.summaries = {}; console.log('Cleared existing summaries.'); }
      const model = f.model || DEFAULT_MODEL;
      console.log(`Summarizing ideas via the claude CLI (${model})…`);
      await summarize(store, { model, limit: f.limit ? Number(f.limit) : 0, log: (s) => console.log(s) });
      saveStore(store);
      console.log(`Done. ${Object.keys(store.summaries || {}).length} ideas labeled. Run \`export\`.`);
      break;
    }
    case 'export': {
      const out = rest[0] || './ai-history-export';
      const store = loadStore();
      if (!store.messages.length) { console.error('No messages. Run `import` first, or try `ai-devlog demo`.'); process.exit(1); }
      const file = exportHtml(payloadFrom(store), out);
      console.log(`Exported → ${file}`);
      break;
    }
    case 'discover': {
      const project = f.project || process.cwd();
      const all = !!f.all;
      const { claudeCode, codex } = discover({ project, all });
      console.log(`Scanned for: ${all ? '(all projects)' : project}\n`);
      const list = (label, arr) => {
        console.log(`${label}: ${arr.length} session(s)`);
        arr.slice(0, 25).forEach((s) => console.log(`  • ${s.title || path.basename(s.file)}${all && s.cwd ? '   [' + s.cwd + ']' : ''}`));
        if (arr.length > 25) console.log(`  … and ${arr.length - 25} more`);
      };
      list('Claude Code', claudeCode);
      list('Codex', codex);
      if (!claudeCode.length && !codex.length) console.log('\nNothing found. Try --all, or import web exports manually.');
      else console.log(`\nRun \`ai-devlog auto${all ? ' --all' : ''}\` to build the HTML.`);
      break;
    }
    case 'auto': {
      const project = f.project || process.cwd();
      const all = !!f.all;
      const out = f.out || rest[0] || './ai-history-export';
      const { claudeCode, codex } = discover({ project, all });
      const found = [...claudeCode, ...codex];
      if (!found.length) {
        console.error(`No Claude Code / Codex sessions found${all ? '' : ` for ${project}`}. Try --all, or import manually.`);
        process.exit(1);
      }
      const store = { project: { name: path.basename(project), repoRoot: project }, messages: [] };
      let imported = 0, skipped = 0;
      for (const s of found) {
        try {
          const parsed = parseSource(s.source, s.file);
          store.messages.push(...parsed.messages);
          imported += parsed.messages.length;
          if (parsed.project?.repoRoot && !store.project.repoRoot) store.project.repoRoot = parsed.project.repoRoot;
          if (parsed.project?.branch && !store.project.branch) store.project.branch = parsed.project.branch;
        } catch (e) { skipped++; }
      }
      let gitMsg = '';
      if (f.git) {
        const repo = store.project.repoRoot || project;
        if (isGitRepo(repo)) {
          store.commits = gitCommits(repo, { since: f.since });
          gitMsg = `, ${store.commits.length} git commits`;
        } else gitMsg = ', (no git repo found)';
      }
      if (f.summarize) {
        console.log('  summarizing ideas via the claude CLI…');
        await summarize(store, { model: f.model || DEFAULT_MODEL, log: (s) => console.log(s) });
      }
      saveStore(store);
      const payload = payloadFrom(store);
      const file = exportHtml(payload, out);
      console.log(`Found ${claudeCode.length} Claude Code + ${codex.length} Codex session(s), ${imported} messages${gitMsg}${skipped ? ` (${skipped} skipped)` : ''}.`);
      console.log(`Exported → ${file}`);
      console.log(`Open it: ${path.resolve(file)}`);
      break;
    }
    case 'demo': {
      const out = rest[0] || './ai-history-export';
      const store = sampleStore();
      saveStore(store);
      const payload = payloadFrom(store);
      const file = exportHtml(payload, out);
      console.log(`Demo exported → ${file}`);
      console.log(`Nodes: ${payload.stats.count}`, payload.stats.types);
      console.log(`Open it: ${path.resolve(file)}`);
      break;
    }
    default:
      help();
  }
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}

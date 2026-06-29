// Read git history so commits/diffs can be correlated to AI turns by time.
import { execFileSync } from 'node:child_process';

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}

export function isGitRepo(repo) {
  try { git(repo, ['rev-parse', '--is-inside-work-tree']); return true; } catch { return false; }
}

// Returns [{ hash, short, author, date(ISO), subject, body, files:[], diff }]
export function gitCommits(repo, { since, max = 1000, diffs = true } = {}) {
  if (!isGitRepo(repo)) return [];
  const REC = '\x1e', FLD = '\x1f';
  const fmt = ['%H', '%h', '%an', '%aI', '%s', '%b'].join(FLD);
  const args = ['log', `--pretty=format:${fmt}${REC}`, '--no-color', `--max-count=${max}`];
  if (since) args.push(`--since=${since}`);

  let raw = '';
  try { raw = git(repo, args); } catch { return []; }

  const commits = [];
  for (const rec of raw.split(REC)) {
    const r = rec.replace(/^\s+/, '');
    if (!r) continue;
    const [hash, short, author, date, subject = '', body = ''] = r.split(FLD);
    if (!hash) continue;

    let files = [];
    try {
      files = git(repo, ['show', '--name-only', '--format=', hash])
        .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch {}

    let diff = null;
    if (diffs && files.length && files.length <= 30) { // skip huge bulk commits
      try { diff = git(repo, ['show', hash, '--no-color', '--unified=2', '--format=']).trim().slice(0, 12000); } catch {}
    }
    commits.push({ hash, short, author, date, subject, body: body.trim(), files, diff });
  }
  return commits;
}

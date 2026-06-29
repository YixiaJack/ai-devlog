// A realistic sample session so `demo` produces a rich tree (ideas, a branch,
// implementations with diffs, a verification turn, commits).

export function sampleStore() {
  return {
    project: {
      id: 'demo',
      name: 'acme-web · AI Devlog',
      repoRoot: '/work/acme-web',
      remote: 'git@github.com:acme/acme-web.git',
      branch: 'feature/auth',
    },
    messages: [
      {
        id: 'm1', source: 'claude-code', sessionId: 'auth refresh-token flow', role: 'user',
        timestamp: '2026-06-20T09:02:00Z',
        content: 'We need to keep users logged in without storing long-lived JWTs. Add a refresh-token flow to the auth service.',
        files: [], commits: [], diff: null,
      },
      {
        id: 'm2', source: 'claude-code', sessionId: 'auth refresh-token flow', role: 'assistant',
        timestamp: '2026-06-20T09:02:40Z', model: 'claude-opus-4-8',
        content:
`I'll add **refresh-token rotation**: short-lived access tokens (15m) plus a rotating refresh token stored httpOnly. Rotation means a stolen refresh token is invalidated on next use.

Plan:
1. \`issueTokens()\` returns access + refresh
2. \`/auth/refresh\` rotates the refresh token
3. store token family id to detect reuse`,
        files: [], commits: [], diff: null,
      },
      {
        id: 'm3', source: 'claude-code', sessionId: 'auth refresh-token flow', role: 'assistant',
        timestamp: '2026-06-20T09:05:10Z', model: 'claude-opus-4-8',
        content: 'Implemented `issueTokens` and the `/auth/refresh` endpoint in `src/auth.ts`.',
        files: ['src/auth.ts', 'src/middleware/auth.ts'],
        commits: ['a1b2c3d'],
        diff:
`@@ src/auth.ts @@
 export async function login(req, res) {
-  const token = signJwt({ uid: user.id }, { expiresIn: '7d' });
-  res.json({ token });
+  const { access, refresh } = await issueTokens(user.id);
+  res.cookie('rt', refresh, { httpOnly: true, sameSite: 'strict' });
+  res.json({ access });
 }
+
+export async function issueTokens(uid) {
+  const family = randomId();
+  const access = signJwt({ uid }, { expiresIn: '15m' });
+  const refresh = await storeRefresh(uid, family);
+  return { access, refresh };
+}`,
      },
      {
        id: 'm4', source: 'claude-code', sessionId: 'auth refresh-token flow', role: 'user',
        timestamp: '2026-06-20T09:12:00Z',
        content: "Actually, don't store refresh tokens in the DB as plaintext — that's a breach risk. Change it to store only a salted hash and compare on refresh.",
        files: [], commits: [], diff: null,
      },
      {
        id: 'm5', source: 'claude-code', sessionId: 'auth refresh-token flow', role: 'assistant',
        timestamp: '2026-06-20T09:14:30Z', model: 'claude-opus-4-8',
        content: 'Good call. Switched storage to a salted SHA-256 hash; the raw token only ever lives in the cookie.',
        files: ['src/auth.ts'],
        commits: ['d4e5f6a'],
        diff:
`@@ src/auth.ts @@
-async function storeRefresh(uid, family) {
-  const token = randomToken();
-  await db.refresh.insert({ uid, family, token });
-  return token;
-}
+async function storeRefresh(uid, family) {
+  const token = randomToken();
+  const hash = sha256(token + SALT);
+  await db.refresh.insert({ uid, family, hash });
+  return token; // raw token returned to client only
+}`,
      },
      {
        id: 'm6', source: 'claude-code', sessionId: 'auth refresh-token flow', role: 'user',
        timestamp: '2026-06-20T09:20:00Z',
        content: 'Run the tests and make sure refresh rotation works end to end.',
        files: [], commits: [], diff: null,
      },
      {
        id: 'm7', source: 'claude-code', sessionId: 'auth refresh-token flow', role: 'assistant',
        timestamp: '2026-06-20T09:22:00Z', model: 'claude-opus-4-8',
        content:
`Added \`tests/auth.refresh.test.ts\`. Results:

\`\`\`
PASS  tests/auth.refresh.test.ts
  ✓ issues access + refresh on login
  ✓ rotates refresh token on /auth/refresh
  ✓ rejects a reused (old) refresh token
\`\`\`

All green. Reuse detection invalidates the whole token family.`,
        files: ['tests/auth.refresh.test.ts'],
        commits: ['b7c8d9e'],
        diff: null,
      },
      {
        id: 'm8', source: 'chatgpt', sessionId: 'rate-limit login endpoint', role: 'user',
        timestamp: '2026-06-21T14:00:00Z',
        content: 'Separately, brute-force protection: add rate limiting to the login endpoint.',
        files: [], commits: [], diff: null,
      },
      {
        id: 'm9', source: 'chatgpt', sessionId: 'rate-limit login endpoint', role: 'assistant',
        timestamp: '2026-06-21T14:01:10Z', model: 'gpt-5.5',
        content: 'Add a sliding-window limiter (5 attempts / 15 min / IP+email) using the existing Redis client. Returns 429 with `Retry-After`.',
        files: ['src/middleware/rateLimit.ts'],
        commits: ['c0ffee1'],
        diff:
`@@ src/middleware/rateLimit.ts @@
+export const loginLimiter = slidingWindow({
+  key: (req) => req.ip + ':' + req.body.email,
+  max: 5, windowMs: 15 * 60 * 1000,
+  onLimit: (res) => res.status(429).set('Retry-After', '900').end(),
+});`,
      },
    ],
  };
}

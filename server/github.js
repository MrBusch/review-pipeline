const { execFile } = require('child_process');

// GitHub access goes through the GitHub CLI (`gh api graphql`), so the app reuses `gh auth login`
// and never stores a token.

function ghRaw(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      { timeout: 120000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } },
      (err, stdout, stderr) => {
        if (err) {
          // gh prints GraphQL errors to stderr but still exits non-zero; keep both for the message.
          const message = (stderr || err.message || '').trim() || 'gh failed';
          return reject(Object.assign(new Error(message), { code: err.code, stdout }));
        }
        resolve(stdout);
      }
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function friendlyError(e) {
  if (e.code === 'ENOENT') return 'Install the GitHub CLI (gh) and run `gh auth login`.';
  if (/auth login|not logged|401|Bad credentials/i.test(e.message)) return 'Run `gh auth login` so the app can read GitHub.';
  if (/Could not resolve to a Repository/i.test(e.message)) return 'Repository not found, or your GitHub account has no access to it.';
  return e.message.split('\n')[0];
}

const RETRYABLE = /secondary rate limit|abuse|timeout|timed out|502|503|504|Something went wrong|ECONNRESET|EOF|couldn't respond/i;

// Run a GraphQL query with retries for GitHub's transient failures and rate limits.
async function graphql(query, variables = {}, { onWait } = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(variables)) {
    if (v === null || v === undefined) continue;
    args.push(typeof v === 'number' || typeof v === 'boolean' ? '-F' : '-f', `${k}=${v}`);
  }
  let attempt = 0;
  for (;;) {
    try {
      const out = JSON.parse(await ghRaw(args));
      if (out.errors?.length && !out.data) throw new Error(out.errors.map((x) => x.message).join('; '));
      const rl = out.data?.rateLimit;
      // Leave headroom: when the hourly budget runs low, wait for the reset rather than failing midway.
      if (rl && rl.remaining < 100) {
        const waitMs = Math.max(0, new Date(rl.resetAt) - Date.now()) + 5000;
        onWait?.(`GitHub rate limit nearly used up; waiting ${Math.ceil(waitMs / 60000)} min for it to reset`);
        await sleep(waitMs);
      }
      return out.data;
    } catch (e) {
      // gh exits non-zero on partial GraphQL errors too; a usable body still counts.
      if (e.stdout) {
        try {
          const out = JSON.parse(e.stdout);
          if (out.data && Object.values(out.data).some(Boolean)) return out.data;
        } catch {
          // not JSON; fall through
        }
      }
      const rateLimited = /API rate limit exceeded|RATE_LIMITED/i.test(e.message);
      if ((RETRYABLE.test(e.message) || rateLimited) && attempt < 6) {
        attempt++;
        const waitMs = rateLimited ? 60000 * attempt : 2000 * 2 ** attempt;
        onWait?.(`GitHub asked us to slow down; retrying in ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
        continue;
      }
      throw Object.assign(new Error(friendlyError(e)), { cause: e, retryable: RETRYABLE.test(e.message) });
    }
  }
}

async function checkRepo(owner, name) {
  const data = await graphql('query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ nameWithOwner isPrivate } }', { owner, name });
  if (!data?.repository) throw new Error('Repository not found, or your GitHub account has no access to it.');
  return data.repository;
}

async function viewer() {
  const data = await graphql('query{ viewer{ login } rateLimit{ remaining limit resetAt } }');
  return { login: data.viewer.login, rateLimit: data.rateLimit };
}

module.exports = { graphql, checkRepo, viewer, friendlyError };

#!/usr/bin/env node
// Command-line access to the same data the app uses.
//   node server/cli.js list
//   node server/cli.js add OWNER/NAME [--months 12]
//   node server/cli.js sync [OWNER/NAME ...]
const { listRepos, addRepo, DB_PATH } = require('./db');
const { syncAll, getStatus } = require('./sync');
const { checkRepo } = require('./github');

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'list' || !cmd) {
    console.log(`Database: ${DB_PATH}`);
    for (const r of listRepos()) console.log(`${r.owner}/${r.name}  PRs: ${r.pr_count}  since: ${r.backfill_since}  last sync: ${r.last_synced_at || 'never'}`);
    return;
  }
  if (cmd === 'add') {
    const [slug] = rest;
    const i = rest.indexOf('--months');
    const months = i >= 0 ? Number(rest[i + 1]) : 12;
    const [owner, name] = (slug || '').split('/');
    if (!owner || !name) throw new Error('Usage: add OWNER/NAME [--months 12]');
    await checkRepo(owner, name);
    const since = new Date();
    since.setUTCMonth(since.getUTCMonth() - months);
    const r = addRepo(owner, name, since.toISOString().slice(0, 10));
    console.log(`Added ${owner}/${name}, backfilling from ${r.backfill_since}. Run "sync" next.`);
    return;
  }
  if (cmd === 'sync') {
    const repos = listRepos().filter((r) => !rest.length || rest.includes(`${r.owner}/${r.name}`));
    const timer = setInterval(() => {
      for (const r of repos) {
        const s = getStatus().repos[r.id];
        if (s?.state === 'running') console.log(`${r.owner}/${r.name}: ${s.fetched}${s.estimate ? ` of ~${s.estimate}` : ''} PRs${s.message ? ` (${s.message})` : ''}`);
      }
    }, 5000);
    await syncAll(repos.map((r) => r.id));
    clearInterval(timer);
    for (const r of repos) {
      const s = getStatus().repos[r.id];
      console.log(`${r.owner}/${r.name}: ${s.state}, ${s.fetched} PRs fetched${s.error ? ` — ${s.error}` : ''}`);
    }
    return;
  }
  throw new Error(`Unknown command "${cmd}"`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

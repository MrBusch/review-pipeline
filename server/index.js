const express = require('express');
const fs = require('fs');
const path = require('path');
const { DB_PATH, listRepos, addRepo, removeRepo, getRepo, resetRepo, getSettings, saveSettings } = require('./db');
const { syncAll, getStatus } = require('./sync');
const { compute, invalidate } = require('./metrics');
const { checkRepo, viewer } = require('./github');

const PORT = Number(process.env.PORT) || 3025;
const HOST = '127.0.0.1';

const app = express();
app.use(express.json());

// Only accept requests addressed to this machine, and no cross-site browser requests.
app.use('/api', (req, res, next) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1'].includes(host)) return res.status(403).json({ error: 'Forbidden host' });
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return res.status(403).json({ error: 'Forbidden origin' });
  if (req.method !== 'GET' && req.method !== 'DELETE' && !req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
  next();
});

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    res.status(e.status || 500).json({ error: e.message });
  });

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s));

// ─── Repos ────────────────────────────────────────────────────────────────────

app.get('/api/repos', wrap(async (req, res) => {
  res.json({ repos: listRepos(), database: DB_PATH });
}));

app.post('/api/repos', wrap(async (req, res) => {
  const slug = String(req.body.repo || '').trim()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  const [owner, name, extra] = slug.split('/');
  if (!owner || !name || extra) throw httpError(400, 'Enter the repository as OWNER/NAME, for example octocat/Hello-World.');
  if (!isDate(req.body.since)) throw httpError(400, 'Pick a start date for the history.');
  if (listRepos().some((r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name.toLowerCase()))
    throw httpError(409, `${owner}/${name} is already added.`);
  const info = await checkRepo(owner, name);
  const [o, n] = info.nameWithOwner.split('/');
  res.json(addRepo(o, n, req.body.since));
}));

app.delete('/api/repos/:id', wrap(async (req, res) => {
  if (getStatus().running || getStatus().externalPid) throw httpError(409, 'Wait for the sync to finish first.');
  removeRepo(Number(req.params.id));
  invalidate();
  res.json({ ok: true });
}));

// Pull the whole history again, optionally from a different start date.
app.post('/api/repos/:id/reset', wrap(async (req, res) => {
  if (getStatus().running || getStatus().externalPid) throw httpError(409, 'Wait for the sync to finish first.');
  const repo = getRepo(Number(req.params.id));
  if (!repo) throw httpError(404, 'Unknown repository');
  if (req.body.since && !isDate(req.body.since)) throw httpError(400, 'Invalid date');
  resetRepo(repo.id, req.body.since);
  res.json(getRepo(repo.id));
}));

// ─── Sync ─────────────────────────────────────────────────────────────────────

app.post('/api/sync', wrap(async (req, res) => {
  if (getStatus().running) throw httpError(409, 'A sync is already running.');
  const ids = Array.isArray(req.body.repoIds) ? req.body.repoIds.map(Number) : undefined;
  syncAll(ids)
    .catch((e) => console.error('[sync]', e.message))
    .finally(invalidate);
  res.json(getStatus());
}));

app.get('/api/sync', wrap(async (req, res) => {
  res.json(getStatus());
}));

app.get('/api/github', wrap(async (req, res) => {
  try {
    res.json({ ok: true, ...(await viewer()) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
}));

// ─── Settings & metrics ───────────────────────────────────────────────────────

app.get('/api/settings', wrap(async (req, res) => res.json(getSettings())));

app.put('/api/settings', wrap(async (req, res) => {
  const clean = (v) => (Array.isArray(v) ? [...new Set(v.map((s) => String(s).trim()).filter(Boolean))] : undefined);
  const patch = {};
  for (const k of ['extraBots', 'ignored']) if (clean(req.body[k])) patch[k] = clean(req.body[k]);
  const s = saveSettings(patch);
  invalidate();
  res.json(s);
}));

app.get('/api/metrics', wrap(async (req, res) => {
  const repoIds = String(req.query.repos || '').split(',').map(Number).filter(Boolean);
  const { from, to } = req.query;
  const granularity = req.query.granularity === 'month' ? 'month' : 'week';
  if (!repoIds.length) throw httpError(400, 'Pick at least one repository.');
  if (!isDate(from) || !isDate(to) || from > to) throw httpError(400, 'Invalid date range');
  res.json(compute({ repoIds, from, to, granularity }));
}));

// ─── Frontend ─────────────────────────────────────────────────────────────────

const DIST = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get('*', (req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

app.listen(PORT, HOST, () => {
  console.log(`Review Pipeline running at http://localhost:${PORT}`);
  console.log(`Data: ${DB_PATH}`);
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// All synced data lives in one SQLite file outside the project folder, so a fresh clone or a
// rebuild never loses it. REVIEW_PIPELINE_DB points somewhere else (handy for tests).
const DB_PATH = process.env.REVIEW_PIPELINE_DB || path.join(os.homedir(), '.review-pipeline', 'review-pipeline.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS repos (
  id              INTEGER PRIMARY KEY,
  owner           TEXT NOT NULL,
  name            TEXT NOT NULL,
  backfill_since  TEXT NOT NULL,          -- ISO date: oldest activity to pull on the first sync
  watermark       TEXT,                   -- updatedAt of the last PR processed (sync resumes here)
  last_synced_at  TEXT,                   -- when the last sync finished successfully
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (owner, name)
);

CREATE TABLE IF NOT EXISTS pull_requests (
  repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number      INTEGER NOT NULL,
  title       TEXT,
  url         TEXT,
  author      TEXT,
  author_type TEXT,                       -- User | Bot | Mannequin | Ghost
  state       TEXT,                       -- OPEN | MERGED | CLOSED
  is_draft    INTEGER,
  created_at  TEXT,
  ready_at    TEXT,                       -- first time it was ready for review (created_at unless opened as draft)
  updated_at  TEXT,
  closed_at   TEXT,
  merged_at   TEXT,
  merged_by   TEXT,
  additions   INTEGER,
  deletions   INTEGER,
  PRIMARY KEY (repo_id, number)
);
CREATE INDEX IF NOT EXISTS pr_created ON pull_requests (created_at);
CREATE INDEX IF NOT EXISTS pr_merged ON pull_requests (merged_at);

CREATE TABLE IF NOT EXISTS reviews (
  id           TEXT PRIMARY KEY,
  repo_id      INTEGER NOT NULL,
  pr_number    INTEGER NOT NULL,
  author       TEXT,
  author_type  TEXT,
  state        TEXT,                      -- APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  submitted_at TEXT,
  FOREIGN KEY (repo_id, pr_number) REFERENCES pull_requests(repo_id, number) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS reviews_pr ON reviews (repo_id, pr_number);
CREATE INDEX IF NOT EXISTS reviews_submitted ON reviews (submitted_at);

-- Timeline events: who asked whom for a review, and when (also removals and draft changes).
CREATE TABLE IF NOT EXISTS pr_events (
  id            TEXT PRIMARY KEY,
  repo_id       INTEGER NOT NULL,
  pr_number     INTEGER NOT NULL,
  kind          TEXT NOT NULL,            -- requested | request_removed | ready | to_draft
  actor         TEXT,
  actor_type    TEXT,
  reviewer      TEXT,
  reviewer_type TEXT,                     -- User | Bot | Team | Mannequin
  created_at    TEXT,
  FOREIGN KEY (repo_id, pr_number) REFERENCES pull_requests(repo_id, number) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS events_pr ON pr_events (repo_id, pr_number);
CREATE INDEX IF NOT EXISTS events_created ON pr_events (created_at);

-- Reviewers still asked to review, as of the PR's last sync.
CREATE TABLE IF NOT EXISTS pending_requests (
  repo_id       INTEGER NOT NULL,
  pr_number     INTEGER NOT NULL,
  reviewer      TEXT NOT NULL,
  reviewer_type TEXT,
  PRIMARY KEY (repo_id, pr_number, reviewer),
  FOREIGN KEY (repo_id, pr_number) REFERENCES pull_requests(repo_id, number) ON DELETE CASCADE
);

-- At most one sync at a time across processes (the app and the command line).
CREATE TABLE IF NOT EXISTS sync_lock (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  pid        INTEGER NOT NULL,
  started_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ─── Cross-process sync lock ──────────────────────────────────────────────────

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Returns the pid of another live process holding the lock, or null.
function otherSyncPid() {
  const row = db.prepare('SELECT pid FROM sync_lock WHERE id = 1').get();
  return row && row.pid !== process.pid && pidAlive(row.pid) ? row.pid : null;
}

function acquireSyncLock() {
  return tx(() => {
    if (otherSyncPid()) return false;
    db.prepare('INSERT OR REPLACE INTO sync_lock (id, pid, started_at) VALUES (1, ?, ?)').run(process.pid, new Date().toISOString());
    return true;
  });
}

function releaseSyncLock() {
  db.prepare('DELETE FROM sync_lock WHERE id = 1 AND pid = ?').run(process.pid);
}

// Changes whenever another process (for example a command-line sync) writes to the database.
// Writes from this process don't change data_version, so count those separately.
let ownWrites = 0;
function dataVersion() {
  return `${db.prepare('PRAGMA data_version').get().data_version}.${ownWrites}`;
}

// ─── Settings ─────────────────────────────────────────────────────────────────
// extraBots: logins to count as bots even though GitHub reports them as users (service accounts).
// ignored:   logins left out of every metric.
const DEFAULT_SETTINGS = { extraBots: [], ignored: [] };

function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      // ignore a malformed value and keep the default
    }
  }
  return out;
}

function saveSettings(patch) {
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  tx(() => {
    for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) upsert.run(k, JSON.stringify(v));
  });
  return getSettings();
}

// ─── Repos ────────────────────────────────────────────────────────────────────

function listRepos() {
  return db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM pull_requests p WHERE p.repo_id = r.id) AS pr_count,
              (SELECT MIN(created_at) FROM pull_requests p WHERE p.repo_id = r.id) AS oldest_pr
       FROM repos r ORDER BY r.owner, r.name`
    )
    .all()
    .map((r) => ({ ...r }));
}

function getRepo(id) {
  const r = db.prepare('SELECT * FROM repos WHERE id = ?').get(id);
  return r ? { ...r } : null;
}

function addRepo(owner, name, backfillSince) {
  db.prepare('INSERT INTO repos (owner, name, backfill_since, created_at) VALUES (?, ?, ?, ?)').run(owner, name, backfillSince, new Date().toISOString());
  return { ...db.prepare('SELECT * FROM repos WHERE owner = ? AND name = ?').get(owner, name) };
}

function removeRepo(id) {
  tx(() => {
    for (const t of ['pending_requests', 'pr_events', 'reviews', 'pull_requests']) db.prepare(`DELETE FROM ${t} WHERE repo_id = ?`).run(id);
    db.prepare('DELETE FROM repos WHERE id = ?').run(id);
  });
}

function updateRepo(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  ownWrites++;
  db.prepare(`UPDATE repos SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}

// Forget the sync position so the next sync pulls everything since backfill_since again.
// Stored rows stay; they are overwritten as PRs come back in.
function resetRepo(id, backfillSince) {
  const fields = { watermark: null, last_error: null };
  if (backfillSince) fields.backfill_since = backfillSince;
  updateRepo(id, fields);
}

// ─── Writing one synced PR ────────────────────────────────────────────────────
// A PR is always written whole: its reviews, events and pending requests are replaced, so syncing
// the same PR twice is harmless.

const stmts = {
  pr: db.prepare(`INSERT INTO pull_requests
      (repo_id, number, title, url, author, author_type, state, is_draft, created_at, ready_at, updated_at, closed_at, merged_at, merged_by, additions, deletions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id, number) DO UPDATE SET
        title = excluded.title, url = excluded.url, author = excluded.author, author_type = excluded.author_type,
        state = excluded.state, is_draft = excluded.is_draft, created_at = excluded.created_at, ready_at = excluded.ready_at,
        updated_at = excluded.updated_at, closed_at = excluded.closed_at, merged_at = excluded.merged_at,
        merged_by = excluded.merged_by, additions = excluded.additions, deletions = excluded.deletions`),
  delReviews: db.prepare('DELETE FROM reviews WHERE repo_id = ? AND pr_number = ?'),
  delEvents: db.prepare('DELETE FROM pr_events WHERE repo_id = ? AND pr_number = ?'),
  delPending: db.prepare('DELETE FROM pending_requests WHERE repo_id = ? AND pr_number = ?'),
  review: db.prepare('INSERT OR REPLACE INTO reviews (id, repo_id, pr_number, author, author_type, state, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  event: db.prepare(
    'INSERT OR REPLACE INTO pr_events (id, repo_id, pr_number, kind, actor, actor_type, reviewer, reviewer_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  pending: db.prepare('INSERT OR IGNORE INTO pending_requests (repo_id, pr_number, reviewer, reviewer_type) VALUES (?, ?, ?, ?)'),
};

function savePullRequests(repoId, prs) {
  ownWrites++;
  tx(() => {
    for (const p of prs) {
      stmts.pr.run(
        repoId, p.number, p.title, p.url, p.author, p.authorType, p.state, p.isDraft ? 1 : 0, p.createdAt, p.readyAt,
        p.updatedAt, p.closedAt, p.mergedAt, p.mergedBy, p.additions, p.deletions
      );
      stmts.delReviews.run(repoId, p.number);
      stmts.delEvents.run(repoId, p.number);
      stmts.delPending.run(repoId, p.number);
      for (const r of p.reviews) stmts.review.run(r.id, repoId, p.number, r.author, r.authorType, r.state, r.submittedAt);
      for (const e of p.events) stmts.event.run(e.id, repoId, p.number, e.kind, e.actor, e.actorType, e.reviewer, e.reviewerType, e.createdAt);
      for (const q of p.pending) stmts.pending.run(repoId, p.number, q.reviewer, q.reviewerType);
    }
  });
}

module.exports = { db, DB_PATH, tx, acquireSyncLock, releaseSyncLock, otherSyncPid, dataVersion, getSettings, saveSettings, listRepos, getRepo, addRepo, removeRepo, updateRepo, resetRepo, savePullRequests };

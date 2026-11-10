const { graphql } = require('./github');
const { db, getRepo, listRepos, updateRepo, savePullRequests, acquireSyncLock, releaseSyncLock, otherSyncPid } = require('./db');

// How a sync works
// ────────────────
// 1. List. GitHub search finds the repo's PRs updated in a time window:
//      repo:OWNER/NAME is:pr updated:A..B
//    We walk from the watermark to now in windows small enough that each fits in one page of 100
//    results (a window with more is split in half). One page per window means no paging cursor, so
//    a PR updated mid-sync can't shift the list and make us skip another.
// 2. Fetch. PRs that are new or whose updatedAt changed are fetched whole by number, in batches:
//    reviews, review-request events, pending reviewers.
// 3. Advance. After each window the watermark moves to the window's end. A sync that stops halfway
//    (closed laptop, rate limit) resumes there, and the next sync only lists what changed since.
//
// Why windows and not "sort:updated-asc from the last updatedAt we saw": search filters and sorts on
// its own index timestamp, which can be hours away from the updatedAt GraphQL returns. Paging by
// updatedAt skipped PRs. The watermark is only ever compared with that same index clock.
//
// The first sync starts at the repo's backfill date. Each later sync starts an hour before the
// watermark, to cover the search index lagging a little behind.

const OVERLAP_MS = 60 * 60 * 1000;
const LIST_LIMIT = 100; // search results per window (one page)
const MIN_WINDOW_MS = 60 * 1000;
const MAX_WINDOW_MS = 30 * 24 * 3600 * 1000;
const BATCH = 20; // PRs fetched in full per request

const ACTOR = '__typename login';
const REVIEWER = '__typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { slug organization { login } }';

const REVIEWS = `id state submittedAt author { ${ACTOR} }`;
const EVENTS = `__typename
  ... on ReviewRequestedEvent { id createdAt actor { ${ACTOR} } requestedReviewer { ${REVIEWER} } }
  ... on ReviewRequestRemovedEvent { id createdAt actor { ${ACTOR} } requestedReviewer { ${REVIEWER} } }
  ... on ReadyForReviewEvent { id createdAt actor { ${ACTOR} } }
  ... on ConvertToDraftEvent { id createdAt actor { ${ACTOR} } }`;
const EVENT_TYPES = '[REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT]';

const PR_FIELDS = `
  number title url state isDraft createdAt updatedAt closedAt mergedAt additions deletions
  author { ${ACTOR} }
  mergedBy { ${ACTOR} }
  reviewRequests(first: 50) { nodes { requestedReviewer { ${REVIEWER} } } }
  reviews(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${REVIEWS} } }
  timelineItems(first: 100, itemTypes: ${EVENT_TYPES}) { pageInfo { hasNextPage endCursor } nodes { ${EVENTS} } }`;

const LIST_QUERY = `query($q: String!, $first: Int!, $after: String) {
  rateLimit { cost remaining resetAt }
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { number updatedAt } }
  }
}`;

const batchQuery = (numbers) => `query($owner: String!, $name: String!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    ${numbers.map((n) => `p${n}: pullRequest(number: ${Number(n)}) { ${PR_FIELDS} }`).join('\n    ')}
  }
}`;

const MORE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $reviewsAfter: String, $eventsAfter: String, $wantReviews: Boolean!, $wantEvents: Boolean!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviews(first: 100, after: $reviewsAfter) @include(if: $wantReviews) { pageInfo { hasNextPage endCursor } nodes { ${REVIEWS} } }
    timelineItems(first: 100, after: $eventsAfter, itemTypes: ${EVENT_TYPES}) @include(if: $wantEvents) { pageInfo { hasNextPage endCursor } nodes { ${EVENTS} } }
  } }
}`;

// ─── Normalizing GitHub's shapes into rows ────────────────────────────────────

const who = (a) => (a ? { login: a.login, type: a.__typename } : { login: 'ghost', type: 'Ghost' });

function reviewerOf(r) {
  if (!r) return null;
  if (r.__typename === 'Team') return { login: `@${r.organization?.login ? r.organization.login + '/' : ''}${r.slug}`, type: 'Team' };
  return r.login ? { login: r.login, type: r.__typename } : null;
}

const EVENT_KIND = {
  ReviewRequestedEvent: 'requested',
  ReviewRequestRemovedEvent: 'request_removed',
  ReadyForReviewEvent: 'ready',
  ConvertToDraftEvent: 'to_draft',
};

function normalize(n, reviewNodes, eventNodes) {
  const author = who(n.author);
  const events = [];
  for (const e of eventNodes) {
    const kind = EVENT_KIND[e.__typename];
    if (!kind || !e.id) continue;
    const actor = who(e.actor);
    const reviewer = reviewerOf(e.requestedReviewer);
    if ((kind === 'requested' || kind === 'request_removed') && !reviewer) continue; // deleted user/team
    events.push({
      id: e.id,
      kind,
      actor: actor.login,
      actorType: actor.type,
      reviewer: reviewer?.login ?? null,
      reviewerType: reviewer?.type ?? null,
      createdAt: e.createdAt,
    });
  }
  events.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // When did review start? A PR opened as a draft becomes reviewable at its first "ready" event.
  const firstDraftEvent = events.find((e) => e.kind === 'ready' || e.kind === 'to_draft');
  let readyAt;
  if (firstDraftEvent?.kind === 'ready') readyAt = firstDraftEvent.createdAt;
  else if (!firstDraftEvent && n.isDraft) readyAt = null;
  else readyAt = n.createdAt;

  const reviews = reviewNodes
    .filter((r) => r.id && r.submittedAt && r.state !== 'PENDING')
    .map((r) => {
      const a = who(r.author);
      return { id: r.id, author: a.login, authorType: a.type, state: r.state, submittedAt: r.submittedAt };
    });

  const pending = (n.reviewRequests?.nodes || [])
    .map((x) => reviewerOf(x.requestedReviewer))
    .filter(Boolean)
    .map((r) => ({ reviewer: r.login, reviewerType: r.type }));

  return {
    number: n.number,
    title: n.title,
    url: n.url,
    author: author.login,
    authorType: author.type,
    state: n.state,
    isDraft: n.isDraft,
    createdAt: n.createdAt,
    readyAt,
    updatedAt: n.updatedAt,
    closedAt: n.closedAt,
    mergedAt: n.mergedAt,
    mergedBy: n.mergedBy?.login ?? null,
    additions: n.additions,
    deletions: n.deletions,
    reviews,
    events,
    pending,
  };
}

// Busy PRs can have more than 100 reviews or events; page through the rest.
async function completePr(repo, n, onWait) {
  const reviews = [...n.reviews.nodes];
  const events = [...n.timelineItems.nodes];
  let rp = n.reviews.pageInfo;
  let ep = n.timelineItems.pageInfo;
  while (rp.hasNextPage || ep.hasNextPage) {
    const data = await graphql(
      MORE_QUERY,
      {
        owner: repo.owner,
        name: repo.name,
        number: n.number,
        reviewsAfter: rp.hasNextPage ? rp.endCursor : null,
        eventsAfter: ep.hasNextPage ? ep.endCursor : null,
        wantReviews: rp.hasNextPage,
        wantEvents: ep.hasNextPage,
      },
      { onWait }
    );
    const pr = data.repository.pullRequest;
    if (pr.reviews) {
      reviews.push(...pr.reviews.nodes);
      rp = pr.reviews.pageInfo;
    } else rp = { hasNextPage: false };
    if (pr.timelineItems) {
      events.push(...pr.timelineItems.nodes);
      ep = pr.timelineItems.pageInfo;
    } else ep = { hasNextPage: false };
  }
  return normalize(n, reviews, events);
}

// ─── Listing and fetching ─────────────────────────────────────────────────────

const isoSec = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function search(q, onWait, after = null, first = LIST_LIMIT) {
  const data = await graphql(LIST_QUERY, { q, first, after }, { onWait });
  return data.search;
}

// Every PR (number → updatedAt) in a query, paging by cursor. Only for small, stable lists, and for
// the rare one-minute window that still holds more than 100 PRs.
async function listAll(q, onWait) {
  const out = new Map();
  let after = null;
  for (;;) {
    const s = await search(q, onWait, after);
    for (const n of s.nodes) if (n?.number) out.set(n.number, n.updatedAt);
    if (!s.pageInfo.hasNextPage) return out;
    after = s.pageInfo.endCursor;
  }
}

// PRs in [fromMs, toMs]. Splits the window until each part fits in one page.
async function listWindow(slug, fromMs, toMs, onWait) {
  const q = `${slug} updated:${isoSec(fromMs)}..${isoSec(toMs)}`;
  const s = await search(q, onWait);
  if (s.issueCount <= LIST_LIMIT) {
    return new Map(s.nodes.filter((n) => n?.number).map((n) => [n.number, n.updatedAt]));
  }
  if (toMs - fromMs <= MIN_WINDOW_MS) return listAll(q, onWait);
  const mid = fromMs + Math.floor((toMs - fromMs) / 2000) * 1000;
  const a = await listWindow(slug, fromMs, mid, onWait);
  const b = await listWindow(slug, mid, toMs, onWait);
  return new Map([...a, ...b]);
}

async function fetchPrs(repo, numbers, onWait) {
  const out = [];
  for (let i = 0; i < numbers.length; i += BATCH) {
    const chunk = numbers.slice(i, i + BATCH);
    const data = await graphql(batchQuery(chunk), { owner: repo.owner, name: repo.name }, { onWait });
    for (const n of chunk) {
      const node = data.repository?.[`p${n}`];
      if (!node) throw new Error(`GitHub returned no data for PR #${n}; try the sync again.`);
      out.push(await completePr(repo, node, onWait));
    }
  }
  return out;
}

const storedStmt = db.prepare('SELECT number, updated_at FROM pull_requests WHERE repo_id = ?');

// ─── Running syncs ────────────────────────────────────────────────────────────

// One sync at a time across all repos; the UI polls `status` for progress.
const status = { running: false, repos: {}, startedAt: null, finishedAt: null };

function repoStatus(id) {
  return (status.repos[id] ||= { state: 'idle', fetched: 0, estimate: null, message: null, error: null });
}

async function syncRepo(repoId) {
  const repo = getRepo(repoId);
  if (!repo) throw new Error('Unknown repository');
  const rs = repoStatus(repoId);
  Object.assign(rs, { state: 'running', fetched: 0, estimate: null, message: null, error: null, startedAt: new Date().toISOString() });
  const onWait = (m) => (rs.message = m);
  const firstSync = !repo.last_synced_at; // also true when resuming an interrupted first sync
  const slug = `repo:${repo.owner}/${repo.name} is:pr`;

  try {
    const stored = new Map(storedStmt.all(repoId).map((r) => [r.number, r.updated_at]));
    const nowMs = Date.now();
    let fromMs = repo.watermark ? new Date(repo.watermark).getTime() - OVERLAP_MS : new Date(repo.backfill_since).getTime();

    // A rough total for the progress bar.
    const total = await search(`${slug} updated:>=${isoSec(fromMs)}`, onWait, null, 1);
    rs.estimate = total.issueCount;
    rs.message = null;

    let size = 24 * 3600 * 1000;
    let listed = 0;
    while (fromMs < nowMs) {
      const toMs = Math.min(nowMs, fromMs + size);
      const found = await listWindow(slug, fromMs, toMs, onWait);
      rs.message = null;
      listed += found.size;
      const changed = [...found].filter(([n, u]) => stored.get(n) !== u).map(([n]) => n);
      const prs = await fetchPrs(repo, changed, onWait);
      rs.message = null;
      savePullRequests(repoId, prs);
      for (const p of prs) stored.set(p.number, p.updatedAt);
      rs.fetched = listed;
      rs.estimate = Math.max(rs.estimate, listed);
      updateRepo(repoId, { watermark: isoSec(toMs) });
      // Aim for about half a page per window.
      if (found.size < LIST_LIMIT / 4) size = Math.min(MAX_WINDOW_MS, size * 2);
      else if (found.size > LIST_LIMIT / 2) size = Math.max(MIN_WINDOW_MS * 10, Math.floor(size / 2));
      fromMs = toMs + 1000;
    }

    // Open PRs whose last activity predates the backfill window still belong in the review queue.
    if (firstSync) {
      const since = new Date(repo.backfill_since).toISOString().slice(0, 10);
      const old = await listAll(`${slug} is:open updated:<${since}`, onWait);
      const changed = [...old].filter(([n, u]) => stored.get(n) !== u).map(([n]) => n);
      savePullRequests(repoId, await fetchPrs(repo, changed, onWait));
      rs.fetched += old.size;
    }

    const now = new Date().toISOString();
    updateRepo(repoId, { last_synced_at: now, last_error: null });
    Object.assign(rs, { state: 'done', message: null, finishedAt: now });
  } catch (e) {
    updateRepo(repoId, { last_error: e.message });
    Object.assign(rs, { state: 'error', error: e.message, message: null, finishedAt: new Date().toISOString() });
    throw e;
  }
}

// Sync the given repos (default: all) one after another. Resolves when finished; errors are
// recorded per repo and don't stop the others.
async function syncAll(repoIds) {
  if (status.running) throw Object.assign(new Error('A sync is already running.'), { status: 409 });
  if (!acquireSyncLock()) throw Object.assign(new Error('A sync is already running in another process (probably the command line).'), { status: 409 });
  const ids = repoIds?.length ? repoIds : listRepos().map((r) => r.id);
  status.running = true;
  status.startedAt = new Date().toISOString();
  status.finishedAt = null;
  for (const id of ids) Object.assign(repoStatus(id), { state: 'queued', fetched: 0, estimate: null, error: null, message: null });
  try {
    for (const id of ids) {
      try {
        await syncRepo(id);
      } catch (e) {
        console.error(`[sync] repo ${id}: ${e.message}`);
      }
    }
  } finally {
    releaseSyncLock();
    status.running = false;
    status.finishedAt = new Date().toISOString();
  }
}

function getStatus() {
  return { ...status, externalPid: status.running ? null : otherSyncPid() };
}

module.exports = { syncAll, getStatus, normalize };

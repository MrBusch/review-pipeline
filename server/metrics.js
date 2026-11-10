const { db, getSettings, dataVersion } = require('./db');

// Every number on the dashboard comes from here. Definitions, in one place:
//
// - A *bot* is an account GitHub reports as a Bot (cursor, copilot-pull-request-reviewer, …), a login
//   ending in [bot], or a login listed under "Count as bots" in Settings.
// - A *review* is a review submitted on someone else's PR. Authors replying in their own review
//   threads show up as "reviews" on GitHub; those are left out. One reviewer leaving several
//   reviews on one PR in the same period counts once ("PRs reviewed").
// - A *review request* is a "review requested" event: the actor asked the reviewer. Re-requests
//   (asking again after changes) count again. Requests to teams count separately from people.
// - *Response time* is from a request to that reviewer's next review on the PR.
// - A merged PR's *approval* is classified from approvals submitted before the merge:
//   human (at least one person approved), bot only (only bots approved), or none.
// - *Time to first review* runs from when the PR was ready for review (created, or marked ready
//   after being a draft) to the first human review by someone other than the author.

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// ─── Dates and buckets ────────────────────────────────────────────────────────

const dayStart = (s) => new Date(`${s}T00:00:00Z`);

function bucketOf(iso, granularity) {
  const d = new Date(iso);
  if (granularity === 'month') return `${d.toISOString().slice(0, 7)}-01`;
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  return m.toISOString().slice(0, 10);
}

function bucketList(fromMs, toMs, granularity) {
  const out = [];
  let k = bucketOf(new Date(fromMs).toISOString(), granularity);
  while (dayStart(k).getTime() < toMs) {
    out.push(k);
    const d = dayStart(k);
    if (granularity === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
    else d.setUTCDate(d.getUTCDate() + 7);
    k = d.toISOString().slice(0, 10);
  }
  return out;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// ─── Loading ──────────────────────────────────────────────────────────────────
// The whole history of the selected repos is small enough to hold in memory; it's cached until
// the next sync (or settings change) bumps `version`.

let version = 0;
const cache = new Map();
function invalidate() {
  version++;
  cache.clear();
}

function load(repoIds) {
  const key = `${version}:${dataVersion()}:${repoIds.join(',')}`;
  if (cache.has(key)) return cache.get(key);
  cache.clear();

  const inList = repoIds.map(() => '?').join(',');
  const repos = new Map(db.prepare(`SELECT id, owner, name FROM repos WHERE id IN (${inList})`).all(...repoIds).map((r) => [r.id, `${r.owner}/${r.name}`]));
  const prs = new Map();
  for (const p of db.prepare(`SELECT * FROM pull_requests WHERE repo_id IN (${inList})`).all(...repoIds)) {
    prs.set(`${p.repo_id}#${p.number}`, { ...p, repo: repos.get(p.repo_id), reviews: [], events: [], pending: [] });
  }
  const attach = (sql, field) => {
    for (const row of db.prepare(sql).all(...repoIds)) prs.get(`${row.repo_id}#${row.pr_number}`)?.[field].push({ ...row });
  };
  attach(`SELECT * FROM reviews WHERE repo_id IN (${inList}) ORDER BY submitted_at`, 'reviews');
  attach(`SELECT * FROM pr_events WHERE repo_id IN (${inList}) ORDER BY created_at`, 'events');
  attach(`SELECT * FROM pending_requests WHERE repo_id IN (${inList})`, 'pending');

  const data = { prs: [...prs.values()] };
  cache.set(key, data);
  return data;
}

// ─── Computing ────────────────────────────────────────────────────────────────

function compute({ repoIds, from, to, granularity = 'week' }) {
  const settings = getSettings();
  const extraBots = new Set(settings.extraBots.map((s) => s.toLowerCase()));
  const ignored = new Set(settings.ignored.map((s) => s.toLowerCase()));
  const isBot = (login, type) => type === 'Bot' || /\[bot\]$/i.test(login || '') || extraBots.has((login || '').toLowerCase());
  const isIgnored = (login) => ignored.has((login || '').toLowerCase());
  const kindOf = (login, type) => (type === 'Team' ? 'team' : isBot(login, type) ? 'bot' : 'human');

  const { prs } = load(repoIds);
  const fromMs = dayStart(from).getTime();
  const toMs = dayStart(to).getTime() + DAY; // inclusive end date
  const prevFromMs = fromMs - (toMs - fromMs);
  const inRange = (iso) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return t >= fromMs && t < toMs;
  };
  const inPrev = (iso) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return t >= prevFromMs && t < fromMs;
  };

  const buckets = bucketList(fromMs, toMs, granularity);
  const series = new Map(
    buckets.map((b) => [
      b,
      {
        bucket: b,
        opened: 0, openedByBots: 0,
        merged: 0, mergedHuman: 0, mergedBotOnly: 0, mergedNoApproval: 0,
        humanReviews: 0, botReviews: 0, humanApprovals: 0, botApprovals: 0,
        requestsToPeople: 0, requestsToBots: 0, requestsToTeams: 0,
        _firstReview: [], _merge: [],
      },
    ])
  );
  const bucketRow = (iso) => series.get(bucketOf(iso, granularity));

  // Per-period totals (current and previous) for the headline tiles.
  const blankTotals = () => ({
    opened: 0, merged: 0, mergedBotOnly: 0, mergedHuman: 0, mergedNoApproval: 0,
    humanReviews: 0, botReviews: 0, requestsToPeople: 0, _firstReview: [], _merge: [], authors: new Set(), reviewers: new Set(),
  });
  const totals = { current: blankTotals(), previous: blankTotals() };
  const periodOf = (iso) => (inRange(iso) ? totals.current : inPrev(iso) ? totals.previous : null);

  const people = new Map();
  const person = (login) => {
    if (!people.has(login))
      people.set(login, {
        login, authored: 0, merged: 0, requestsSent: 0, requestsSentToBots: 0, requestsReceived: 0,
        prsReviewed: 0, approvals: 0, changesRequested: 0, commentOnly: 0,
        _response: [], answered: 0, unanswered: 0, waiting: 0, pendingNow: 0, oldestPendingH: null,
        series: new Map(),
      });
    return people.get(login);
  };
  const personBucket = (p, iso) => {
    const b = bucketOf(iso, granularity);
    if (!p.series.has(b)) p.series.set(b, { bucket: b, reviewed: 0, requested: 0, authored: 0, merged: 0, sent: 0 });
    return p.series.get(b);
  };

  const bots = new Map();
  const bot = (login) => {
    if (!bots.has(login)) bots.set(login, { login, prsReviewed: 0, approvals: 0, commentOnly: 0, changesRequested: 0, requested: 0, soleApprovals: 0, series: new Map() });
    return bots.get(login);
  };

  const matrix = new Map(); // "requester\treviewer" → n
  const teamRequests = new Map();
  const queue = [];
  const now = Date.now();

  for (const pr of prs) {
    if (isIgnored(pr.author)) continue;
    const authorBot = isBot(pr.author, pr.author_type);
    const start = pr.ready_at || pr.created_at;

    // Reviews by others, collapsed to one per (reviewer, period bucket).
    const others = pr.reviews.filter((r) => r.author !== pr.author && !isIgnored(r.author));
    const seenBucket = new Set();
    const seenRange = new Set();
    for (const r of others) {
      const kind = kindOf(r.author, r.author_type);
      const k = `${r.author}|${bucketOf(r.submitted_at, granularity)}`;
      const row = inRange(r.submitted_at) ? bucketRow(r.submitted_at) : null;
      const period = periodOf(r.submitted_at);
      const periodKey = `${r.author}|${period === totals.current ? 'c' : 'p'}`;
      if (period && !seenRange.has(periodKey)) {
        seenRange.add(periodKey);
        if (kind === 'bot') period.botReviews++;
        else {
          period.humanReviews++;
          period.reviewers.add(r.author);
        }
      }
      if (!row) continue;
      const first = !seenBucket.has(k);
      seenBucket.add(k);
      if (kind === 'bot') {
        const b = bot(r.author);
        if (first) {
          row.botReviews++;
          const bs = b.series.get(row.bucket) || 0;
          b.series.set(row.bucket, bs + 1);
        }
        if (r.state === 'APPROVED') row.botApprovals++;
      } else {
        const p = person(r.author);
        if (first) {
          row.humanReviews++;
          personBucket(p, r.submitted_at).reviewed++;
        }
        if (r.state === 'APPROVED') row.humanApprovals++;
      }
    }
    // Per reviewer, over the whole range: PRs reviewed and the strongest verdicts given.
    const byReviewer = new Map();
    for (const r of others) {
      if (!inRange(r.submitted_at)) continue;
      if (!byReviewer.has(r.author)) byReviewer.set(r.author, { type: r.author_type, states: new Set() });
      byReviewer.get(r.author).states.add(r.state);
    }
    for (const [login, { type, states }] of byReviewer) {
      const target = kindOf(login, type) === 'bot' ? bot(login) : person(login);
      target.prsReviewed++;
      if (states.has('APPROVED')) target.approvals++;
      if (states.has('CHANGES_REQUESTED')) target.changesRequested++;
      if (!states.has('APPROVED') && !states.has('CHANGES_REQUESTED')) target.commentOnly++;
    }

    // Opened.
    if (inRange(pr.created_at) || inPrev(pr.created_at)) {
      const period = periodOf(pr.created_at);
      period.opened++;
      if (!authorBot) period.authors.add(pr.author);
      if (inRange(pr.created_at)) {
        const row = bucketRow(pr.created_at);
        row.opened++;
        if (authorBot) row.openedByBots++;
        if (!authorBot) {
          const p = person(pr.author);
          p.authored++;
          personBucket(p, pr.created_at).authored++;
        }
      }
    }

    // Time to first human review, bucketed by when the PR became ready.
    if (start && !authorBot) {
      const firstHuman = others.find((r) => kindOf(r.author, r.author_type) === 'human' && r.submitted_at >= start);
      if (firstHuman) {
        const h = (new Date(firstHuman.submitted_at) - new Date(start)) / HOUR;
        periodOf(start)?._firstReview.push(h);
        if (inRange(start)) bucketRow(start)._firstReview.push(h);
      }
    }

    // Merged, and how it was approved.
    if (pr.merged_at && (inRange(pr.merged_at) || inPrev(pr.merged_at))) {
      const approvers = others.filter((r) => r.state === 'APPROVED' && r.submitted_at <= pr.merged_at);
      const humanApproved = approvers.some((r) => kindOf(r.author, r.author_type) !== 'bot');
      const botApproved = approvers.some((r) => kindOf(r.author, r.author_type) === 'bot');
      const cls = humanApproved ? 'mergedHuman' : botApproved ? 'mergedBotOnly' : 'mergedNoApproval';
      const period = periodOf(pr.merged_at);
      period.merged++;
      period[cls]++;
      const mergeH = start ? (new Date(pr.merged_at) - new Date(start)) / HOUR : null;
      if (mergeH != null && mergeH >= 0) period._merge.push(mergeH);
      if (inRange(pr.merged_at)) {
        const row = bucketRow(pr.merged_at);
        row.merged++;
        row[cls]++;
        if (mergeH != null && mergeH >= 0) row._merge.push(mergeH);
        if (!authorBot) {
          const p = person(pr.author);
          p.merged++;
          personBucket(p, pr.merged_at).merged++;
        }
        if (cls === 'mergedBotOnly') for (const login of new Set(approvers.map((r) => r.author))) bot(login).soleApprovals++;
      }
    }

    // Review requests.
    for (const e of pr.events) {
      if (e.kind !== 'requested' || !(inRange(e.created_at) || inPrev(e.created_at))) continue;
      if (isIgnored(e.actor) || isIgnored(e.reviewer) || e.actor === e.reviewer) continue;
      const kind = kindOf(e.reviewer, e.reviewer_type);
      if (inPrev(e.created_at)) {
        if (kind === 'human') totals.previous.requestsToPeople++;
        continue;
      }
      if (kind === 'human') totals.current.requestsToPeople++;
      const row = bucketRow(e.created_at);
      const actorHuman = kindOf(e.actor, e.actor_type) === 'human';
      if (kind === 'bot') {
        row.requestsToBots++;
        bot(e.reviewer).requested++;
        if (actorHuman) person(e.actor).requestsSentToBots++;
        continue;
      }
      if (kind === 'team') {
        row.requestsToTeams++;
        teamRequests.set(e.reviewer, (teamRequests.get(e.reviewer) || 0) + 1);
        continue;
      }
      row.requestsToPeople++;
      const reviewer = person(e.reviewer);
      reviewer.requestsReceived++;
      personBucket(reviewer, e.created_at).requested++;
      if (actorHuman) {
        const actor = person(e.actor);
        actor.requestsSent++;
        personBucket(actor, e.created_at).sent++;
        const mk = `${e.actor}\t${e.reviewer}`;
        matrix.set(mk, (matrix.get(mk) || 0) + 1);
      }

      // Response: the reviewer's next review on this PR after the request.
      const t = e.created_at;
      const answer = pr.reviews.find((r) => r.author === e.reviewer && r.submitted_at >= t);
      const withdrawn = pr.events.find((x) => x.kind === 'request_removed' && x.reviewer === e.reviewer && x.created_at >= t);
      if (answer && (!withdrawn || answer.submitted_at <= withdrawn.created_at)) {
        reviewer.answered++;
        reviewer._response.push((new Date(answer.submitted_at) - new Date(t)) / HOUR);
      } else if (withdrawn) {
        // request taken back before a review: neither answered nor ignored
      } else if (pr.state === 'OPEN') reviewer.waiting++;
      else reviewer.unanswered++;
    }

    // The current review queue: open, non-draft PRs.
    if (pr.state === 'OPEN' && !pr.is_draft) {
      const waitingOn = pr.pending
        .filter((q) => !isIgnored(q.reviewer))
        .map((q) => {
          const req = [...pr.events].reverse().find((e) => e.kind === 'requested' && e.reviewer === q.reviewer);
          const since = req?.created_at || start;
          return { reviewer: q.reviewer, kind: kindOf(q.reviewer, q.reviewer_type), since, waitingH: round1((now - new Date(since)) / HOUR) };
        });
      for (const w of waitingOn) {
        if (w.kind !== 'human') continue;
        const p = person(w.reviewer);
        p.pendingNow++;
        p.oldestPendingH = Math.max(p.oldestPendingH ?? 0, w.waitingH);
      }
      const humanApproved = others.some((r) => r.state === 'APPROVED' && kindOf(r.author, r.author_type) === 'human');
      const botApproved = others.some((r) => r.state === 'APPROVED' && kindOf(r.author, r.author_type) === 'bot');
      const humanReviewed = others.some((r) => kindOf(r.author, r.author_type) === 'human');
      queue.push({
        repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, author: pr.author, authorIsBot: authorBot,
        readyAt: start, ageH: round1((now - new Date(start)) / HOUR), updatedAt: pr.updated_at,
        waitingOn, humanApproved, botApproved, humanReviewed,
      });
    }
  }

  // ─── Shape the output ──────────────────────────────────────────────────────

  const seriesOut = [...series.values()].map(({ _firstReview, _merge, ...row }) => ({
    ...row,
    botOnlyShare: row.merged ? round1((100 * row.mergedBotOnly) / row.merged) : null,
    medianFirstReviewH: round1(median(_firstReview)),
    medianMergeH: round1(median(_merge)),
  }));

  const finishTotals = ({ _firstReview, _merge, authors, reviewers, ...t }) => ({
    ...t,
    botOnlyShare: t.merged ? round1((100 * t.mergedBotOnly) / t.merged) : null,
    medianFirstReviewH: round1(median(_firstReview)),
    medianMergeH: round1(median(_merge)),
    activeAuthors: authors.size,
    activeReviewers: reviewers.size,
  });

  const peopleOut = [...people.values()]
    .map(({ _response, series: s, ...p }) => ({
      ...p,
      medianResponseH: round1(median(_response)),
      answeredPct: p.answered + p.unanswered ? Math.round((100 * p.answered) / (p.answered + p.unanswered)) : null,
      series: buckets.map((b) => s.get(b) || { bucket: b, reviewed: 0, requested: 0, authored: 0, merged: 0, sent: 0 }),
    }))
    .filter((p) => p.authored || p.merged || p.prsReviewed || p.requestsReceived || p.requestsSent || p.pendingNow)
    .sort((a, b) => b.prsReviewed - a.prsReviewed || b.requestsReceived - a.requestsReceived);

  const botsOut = [...bots.values()]
    .map(({ series: s, ...b }) => ({ ...b, series: buckets.map((k) => s.get(k) || 0) }))
    .sort((a, b) => b.prsReviewed - a.prsReviewed || b.requested - a.requested);

  // Request matrix: everyone who sent or received a request between people.
  const sentTotals = new Map();
  const recvTotals = new Map();
  for (const [k, n] of matrix) {
    const [a, b] = k.split('\t');
    sentTotals.set(a, (sentTotals.get(a) || 0) + n);
    recvTotals.set(b, (recvTotals.get(b) || 0) + n);
  }
  const byCount = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

  queue.sort((a, b) => b.ageH - a.ageH);

  return {
    range: { from, to, granularity, previousFrom: new Date(prevFromMs).toISOString().slice(0, 10) },
    buckets,
    totals: { current: finishTotals(totals.current), previous: finishTotals(totals.previous) },
    series: seriesOut,
    people: peopleOut,
    bots: botsOut,
    matrix: {
      requesters: byCount(sentTotals),
      reviewers: byCount(recvTotals),
      cells: [...matrix.entries()].map(([k, n]) => [...k.split('\t'), n]),
    },
    teams: [...teamRequests.entries()].map(([team, n]) => ({ team, n })).sort((a, b) => b.n - a.n),
    queue,
  };
}

module.exports = { compute, invalidate };

// Run with: npm test (from the project root)
const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-pipeline-test-'));
process.env.REVIEW_PIPELINE_DB = path.join(dir, 'test.db');

const { addRepo, savePullRequests, saveSettings } = require('../db');
const { compute, invalidate } = require('../metrics');
const { normalize } = require('../sync');

const repo = addRepo('acme', 'app', '2026-01-01');

let seq = 0;
const id = () => `n${++seq}`;
const user = (login) => ({ __typename: 'User', login });
const botUser = (login) => ({ __typename: 'Bot', login });

// Build a PR the way GitHub's GraphQL returns it, then run it through the real normalizer.
function pr({ number, author = 'alice', created, merged = null, state = merged ? 'MERGED' : 'OPEN', isDraft = false, reviews = [], events = [], pending = [] }) {
  return normalize(
    {
      number, title: `PR ${number}`, url: `https://github.com/acme/app/pull/${number}`, state, isDraft,
      createdAt: created, updatedAt: merged || created, closedAt: merged, mergedAt: merged, additions: 1, deletions: 1,
      author: user(author), mergedBy: merged ? user(author) : null,
      reviewRequests: { nodes: pending.map((p) => ({ requestedReviewer: p })) },
    },
    reviews.map(([who, st, at]) => ({ id: id(), state: st, submittedAt: at, author: who })),
    events.map(([type, actor, reviewer, at]) => ({ __typename: type, id: id(), createdAt: at, actor, requestedReviewer: reviewer }))
  );
}

savePullRequests(repo.id, [
  // Merged with only a bot approval; the author's own thread replies must not count as reviews.
  pr({
    number: 1, created: '2026-03-02T10:00:00Z', merged: '2026-03-02T14:00:00Z',
    reviews: [[botUser('cursor'), 'APPROVED', '2026-03-02T10:30:00Z'], [user('alice'), 'COMMENTED', '2026-03-02T11:00:00Z']],
  }),
  // Merged with a human approval (bob, asked by alice, answered after 2 h) plus a bot approval.
  pr({
    number: 2, created: '2026-03-03T09:00:00Z', merged: '2026-03-03T15:00:00Z',
    events: [['ReviewRequestedEvent', user('alice'), user('bob'), '2026-03-03T09:00:00Z'], ['ReviewRequestedEvent', user('alice'), botUser('copilot'), '2026-03-03T09:00:00Z']],
    reviews: [
      [botUser('copilot'), 'COMMENTED', '2026-03-03T09:05:00Z'],
      [botUser('cursor'), 'APPROVED', '2026-03-03T09:10:00Z'],
      [user('bob'), 'COMMENTED', '2026-03-03T11:00:00Z'],
      [user('bob'), 'APPROVED', '2026-03-03T12:00:00Z'],
    ],
  }),
  // Opened as a draft, marked ready a day later; carol is still a pending reviewer.
  pr({
    number: 3, author: 'bob', created: '2026-03-04T09:00:00Z', isDraft: false,
    events: [
      ['ReadyForReviewEvent', user('bob'), null, '2026-03-05T09:00:00Z'],
      ['ReviewRequestedEvent', user('bob'), user('carol'), '2026-03-05T09:00:00Z'],
    ],
    pending: [user('carol')],
  }),
  // Merged without any approval.
  pr({ number: 4, author: 'carol', created: '2026-03-04T12:00:00Z', merged: '2026-03-04T13:00:00Z' }),
]);

const run = (extra = {}) => compute({ repoIds: [repo.id], from: '2026-03-02', to: '2026-03-08', granularity: 'week', ...extra });

test('classifies how merged PRs were approved', () => {
  const t = run().totals.current;
  assert.equal(t.merged, 3);
  assert.equal(t.mergedBotOnly, 1);
  assert.equal(t.mergedHuman, 1);
  assert.equal(t.mergedNoApproval, 1);
  assert.equal(t.botOnlyShare, 33.3);
});

test('counts PRs opened and merged per person per bucket', () => {
  const m = run();
  const sum = (p, k) => p.series.reduce((s, r) => s + r[k], 0);
  for (const p of m.people) {
    assert.equal(sum(p, 'authored'), p.authored);
    assert.equal(sum(p, 'merged'), p.merged);
  }
  const carol = m.people.find((p) => p.login === 'carol');
  assert.equal(carol.merged, 1);
});

test('ignores authors reviewing their own PRs and counts one review per reviewer per PR', () => {
  const m = run();
  const alice = m.people.find((p) => p.login === 'alice');
  const bob = m.people.find((p) => p.login === 'bob');
  assert.equal(alice.prsReviewed, 0);
  assert.equal(bob.prsReviewed, 1);
  assert.equal(bob.approvals, 1);
  assert.equal(m.totals.current.humanReviews, 1);
  assert.equal(m.series[0].humanReviews, 1);
});

test('tracks review requests, bots separately, and response time', () => {
  const m = run();
  const alice = m.people.find((p) => p.login === 'alice');
  const bob = m.people.find((p) => p.login === 'bob');
  assert.equal(alice.requestsSent, 1);
  assert.equal(alice.requestsSentToBots, 1);
  assert.equal(bob.requestsReceived, 1);
  assert.equal(bob.medianResponseH, 2);
  assert.equal(bob.answeredPct, 100);
  assert.deepEqual(m.matrix.cells, [['alice', 'bob', 1], ['bob', 'carol', 1]]);
  const copilot = m.bots.find((b) => b.login === 'copilot');
  assert.equal(copilot.requested, 1);
  assert.equal(m.bots.find((b) => b.login === 'cursor').soleApprovals, 1);
});

test('measures time to first human review from when the PR became ready', () => {
  const m = run();
  // Only PR 2 has a human review: 09:00 → 11:00.
  assert.equal(m.totals.current.medianFirstReviewH, 2);
});

test('lists open PRs waiting on a reviewer', () => {
  const m = run();
  assert.equal(m.queue.length, 1);
  assert.equal(m.queue[0].number, 3);
  assert.equal(m.queue[0].readyAt, '2026-03-05T09:00:00Z');
  assert.deepEqual(m.queue[0].waitingOn.map((w) => w.reviewer), ['carol']);
  assert.equal(m.people.find((p) => p.login === 'carol').pendingNow, 1);
});

test('settings can reclassify a user as a bot or ignore them', () => {
  saveSettings({ extraBots: ['bob'], ignored: [] });
  invalidate();
  let m = run();
  assert.equal(m.totals.current.mergedHuman, 0);
  assert.equal(m.totals.current.mergedBotOnly, 2);
  assert.ok(m.bots.some((b) => b.login === 'bob'));

  saveSettings({ extraBots: [], ignored: ['carol'] });
  invalidate();
  m = run();
  assert.equal(m.totals.current.merged, 2);
  assert.ok(!m.people.some((p) => p.login === 'carol'));
  saveSettings({ extraBots: [], ignored: [] });
  invalidate();
});

test('monthly buckets', () => {
  const m = run({ granularity: 'month', from: '2026-01-01', to: '2026-04-30' });
  assert.deepEqual(m.buckets, ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
  assert.equal(m.series[2].opened, 4);
});

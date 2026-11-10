import React, { useMemo, useState } from 'react';
import { Card, BarList, useColors } from './charts';
import { SortTable } from './People';
import { fmtHours, fmtNum } from './util';

const FILTERS = [
  { key: 'waiting', label: 'Waiting on a reviewer', test: (q) => q.waitingOn.some((w) => w.kind !== 'bot') },
  { key: 'none', label: 'No reviewer asked', test: (q) => !q.humanApproved && !q.waitingOn.some((w) => w.kind !== 'bot') },
  { key: 'approved', label: 'Approved, not merged', test: (q) => q.humanApproved },
  { key: 'all', label: 'All open', test: () => true },
];

const AGES = [
  { key: 'all', label: 'Any age', maxH: Infinity },
  { key: '30d', label: 'Last 30 days', maxH: 30 * 24 },
  { key: '7d', label: 'Last 7 days', maxH: 7 * 24 },
];

export default function Queue({ m, multiRepo }) {
  const c = useColors();
  const [filter, setFilter] = useState('waiting');
  const [age, setAge] = useState('30d');
  const [hideBots, setHideBots] = useState(true);

  const maxH = AGES.find((a) => a.key === age).maxH;
  const base = useMemo(() => m.queue.filter((q) => (!hideBots || !q.authorIsBot) && q.ageH <= maxH), [m.queue, hideBots, maxH]);
  const rows = base.filter(FILTERS.find((f) => f.key === filter).test);

  const byReviewer = useMemo(() => {
    const map = new Map();
    for (const q of base)
      for (const w of q.waitingOn) {
        if (w.kind === 'bot') continue;
        const e = map.get(w.reviewer) || { n: 0, oldest: 0 };
        e.n++;
        e.oldest = Math.max(e.oldest, w.waitingH);
        map.set(w.reviewer, e);
      }
    return [...map.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15);
  }, [base]);

  return (
    <>
      <p className="explain">
        Open pull requests that are ready for review (drafts left out), as of the last sync. Ages are wall-clock time since the PR became ready, or since the
        reviewer was asked.
      </p>
      <div className="stat-row">
        {FILTERS.map((f) => (
          <div key={f.key} className="kpi clickable" style={{ cursor: 'pointer', outline: filter === f.key ? '2px solid var(--accent)' : undefined }} onClick={() => setFilter(f.key)}>
            <div className="kpi-label">{f.label}</div>
            <div className="kpi-value">{fmtNum(base.filter(f.test).length)}</div>
          </div>
        ))}
      </div>

      <div className="toolbar">
        <div className="segmented">
          {AGES.map((a) => (
            <button key={a.key} className={age === a.key ? 'active' : ''} onClick={() => setAge(a.key)}>
              {a.label}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={hideBots} onChange={(e) => setHideBots(e.target.checked)} />
          Hide PRs opened by bots
        </label>
      </div>

      {byReviewer.length > 0 && (
        <Card title="Reviews waiting on each person" sub="Open PRs where the person is still a requested reviewer. Hover for the oldest wait.">
          <BarList rows={byReviewer.map(([login, e]) => ({ label: login, value: e.n, hint: `oldest waiting ${fmtHours(e.oldest)}` }))} color={c.s1} />
        </Card>
      )}

      <div className="section-title">{FILTERS.find((f) => f.key === filter).label}</div>
      <SortTable
        rowKey={(q) => `${q.repo}#${q.number}`}
        rows={rows}
        initialSort={{ key: 'ageH', dir: 'desc' }}
        empty="Nothing in this list."
        columns={[
          {
            key: 'number',
            label: 'Pull request',
            className: 'commit-col',
            sortValue: (q) => q.number,
            render: (q) => (
              <div className="commit">
                <a href={q.url} target="_blank" rel="noreferrer" className="truncate">
                  {q.title}
                </a>
                <span className="dim small">
                  {multiRepo ? `${q.repo} ` : ''}#{q.number}
                </span>
              </div>
            ),
          },
          { key: 'author', label: 'Author', render: (q) => q.author + (q.authorIsBot ? ' (bot)' : '') },
          { key: 'ageH', label: 'Open for', num: true, render: (q) => fmtHours(q.ageH) },
          {
            key: 'waiting',
            label: 'Waiting on',
            sortValue: (q) => Math.max(0, ...q.waitingOn.map((w) => w.waitingH)),
            render: (q) =>
              q.waitingOn.length ? (
                <div className="chips">
                  {q.waitingOn.map((w) => (
                    <span key={w.reviewer} className={`chip ${w.kind === 'bot' ? 'chip-muted' : w.waitingH > 48 ? 'chip-warn' : 'chip-info'}`} title={`asked ${fmtHours(w.waitingH)} ago`}>
                      {w.reviewer} · {fmtHours(w.waitingH)}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="dim">nobody</span>
              ),
          },
          {
            key: 'status',
            label: 'Reviews so far',
            sortValue: (q) => (q.humanApproved ? 3 : q.humanReviewed ? 2 : q.botApproved ? 1 : 0),
            render: (q) => (
              <div className="chips">
                {q.humanApproved && <span className="chip chip-good">approved</span>}
                {!q.humanApproved && q.humanReviewed && <span className="chip chip-muted">reviewed</span>}
                {q.botApproved && <span className="chip chip-muted">bot approved</span>}
                {!q.humanReviewed && !q.botApproved && <span className="dim small">none</span>}
              </div>
            ),
          },
        ]}
      />
    </>
  );
}

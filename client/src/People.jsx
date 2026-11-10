import React, { useMemo, useState } from 'react';
import { Card, TimeChart, useColors, SLOTS } from './charts';
import { fmtHours, fmtNum, fmtPct } from './util';

const TOP = 8;

export function SortTable({ columns, rows, initialSort, rowKey, onRowClick, selected, renderExpanded, empty = 'Nothing here.' }) {
  const [sort, setSort] = useState(initialSort);
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort.key);
    const val = col?.sortValue || ((r) => r[sort.key]);
    return [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const d = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return sort.dir === 'asc' ? d : -d;
    });
  }, [rows, sort, columns]);

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={`sortable${c.num ? ' num' : ''}${sort.key === c.key ? ' sorted' : ''}`}
                title={c.hint}
                onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key && s.dir === 'desc' ? 'asc' : c.num ? 'desc' : 'asc' }))}
              >
                {c.label}
                {sort.key === c.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {!sorted.length && (
            <tr>
              <td className="empty dim" colSpan={columns.length}>
                {empty}
              </td>
            </tr>
          )}
          {sorted.map((r) => (
            <React.Fragment key={rowKey(r)}>
              <tr className={`${onRowClick ? 'clickable' : ''}${selected === rowKey(r) ? ' selected' : ''}`} onClick={() => onRowClick?.(r)}>
                {columns.map((c) => (
                  <td key={c.key} className={c.num ? 'num' : c.className}>
                    {c.render ? c.render(r) : r[c.key]}
                  </td>
                ))}
              </tr>
              {selected === rowKey(r) && renderExpanded && (
                <tr className="expand-row">
                  <td colSpan={columns.length} style={{ background: 'var(--surface)' }}>
                    {renderExpanded(r)}
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const sumOf = (p, metric) => p.series.reduce((s, r) => s + r[metric], 0);
const topBy = (people, metric) =>
  people
    .map((p) => ({ p, n: sumOf(p, metric) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, TOP)
    .map((x) => x.p);

// Stacked per-person chart for one metric: the top people by total keep fixed slots, the rest fold
// into "Everyone else".
function PeopleStack({ m, metric, title, what, height = 260, slots }) {
  const c = useColors();
  const g = m.range.granularity;
  const top = useMemo(() => topBy(m.people, metric), [m.people, metric]);
  // Keep each person's color across charts; someone without a shared slot borrows one that is free here.
  const colorOf = useMemo(() => {
    const used = new Set(top.map((p) => slots.get(p.login)).filter((x) => x != null));
    const free = SLOTS.map((_, i) => i).filter((i) => !used.has(i));
    return new Map(top.map((p) => [p.login, slots.get(p.login) ?? free.shift()]));
  }, [top, slots]);
  const data = useMemo(
    () =>
      m.buckets.map((b, i) => {
        const row = { bucket: b };
        let topSum = 0;
        top.forEach((p, j) => {
          row[`p${j}`] = p.series[i][metric];
          topSum += p.series[i][metric];
        });
        const all = m.people.reduce((s, p) => s + p.series[i][metric], 0);
        row.other = all - topSum;
        row.total = all;
        return row;
      }),
    [m, top, metric]
  );
  const rest = m.people.length > top.length;
  return (
    <Card title={title} sub={`${what} per ${g === 'month' ? 'month' : 'week'}, top ${top.length} people by total in this period.`}>
      <TimeChart
        data={data}
        granularity={g}
        height={height}
        series={[
          ...top.map((p, j) => ({ key: `p${j}`, label: p.login, color: c[SLOTS[colorOf.get(p.login)]] })),
          ...(rest ? [{ key: 'other', label: 'Everyone else', color: c['s-other'] }] : []),
        ]}
        foot={(r) => `${fmtNum(r.total)} in total`}
      />
    </Card>
  );
}

export default function People({ m }) {
  const c = useColors();
  const g = m.range.granularity;
  const [selected, setSelected] = useState(null);

  // One color per person across the three charts: the first 8 people to appear (reviewers first) own a slot.
  const slots = useMemo(() => {
    const map = new Map();
    for (const metric of ['reviewed', 'authored', 'merged'])
      for (const p of topBy(m.people, metric)) if (!map.has(p.login) && map.size < SLOTS.length) map.set(p.login, map.size);
    return map;
  }, [m.people]);

  const columns = [
    { key: 'login', label: 'Person', render: (p) => <span className="strong">{p.login}</span> },
    { key: 'authored', label: 'PRs opened', num: true, render: (p) => fmtNum(p.authored) },
    { key: 'merged', label: 'PRs merged', num: true, hint: 'Their PRs merged in this period, whoever pressed merge.', render: (p) => fmtNum(p.merged) },
    { key: 'requestsSent', label: 'Reviews asked for', num: true, hint: 'Review requests this person sent to other people (re-requests count again).', render: (p) => fmtNum(p.requestsSent) },
    { key: 'requestsReceived', label: 'Asked to review', num: true, hint: 'Review requests this person received from others.', render: (p) => fmtNum(p.requestsReceived) },
    { key: 'prsReviewed', label: 'PRs reviewed', num: true, hint: "Other people's PRs this person left at least one review on.", render: (p) => fmtNum(p.prsReviewed) },
    { key: 'approvals', label: 'Approved', num: true, render: (p) => fmtNum(p.approvals) },
    { key: 'changesRequested', label: 'Changes req.', num: true, render: (p) => fmtNum(p.changesRequested) },
    {
      key: 'ratio',
      label: 'Reviewed per PR opened',
      num: true,
      hint: 'PRs reviewed ÷ PRs opened. Above 1: reviews more than they ship; below 1: leans on others.',
      sortValue: (p) => (p.authored ? p.prsReviewed / p.authored : null),
      render: (p) => (p.authored ? (p.prsReviewed / p.authored).toFixed(1) : '–'),
    },
    { key: 'medianResponseH', label: 'Median response', num: true, hint: 'From a review request to their next review on that PR. Wall-clock time.', render: (p) => fmtHours(p.medianResponseH) },
    {
      key: 'answeredPct',
      label: 'Requests answered',
      num: true,
      hint: 'Of the requests to this person on PRs that are now closed or merged, the share they reviewed. Withdrawn requests are left out.',
      render: (p) => fmtPct(p.answeredPct),
    },
    {
      key: 'pendingNow',
      label: 'Waiting on them now',
      num: true,
      hint: 'Open PRs (not drafts) where this person is still a requested reviewer, as of the last sync.',
      render: (p) => (p.pendingNow ? <span style={{ whiteSpace: 'nowrap' }}>{`${p.pendingNow} · oldest ${fmtHours(p.oldestPendingH)}`}</span> : '–'),
    },
  ];

  return (
    <>
      <PeopleStack m={m} metric="reviewed" slots={slots} title="Who does the reviewing" what="Other people's PRs reviewed" />
      <div className="grid-2">
        <PeopleStack m={m} metric="authored" slots={slots} title="Who opens PRs" what="PRs opened" height={240} />
        <PeopleStack m={m} metric="merged" slots={slots} title="Whose PRs get merged" what="PRs merged, by PR author," height={240} />
      </div>

      <div className="section-title">People</div>
      <p className="explain">Bots are left out here; see the Bots tab. Click a person for their trend.</p>
      <SortTable
        columns={columns}
        rows={m.people}
        rowKey={(p) => p.login}
        initialSort={{ key: 'prsReviewed', dir: 'desc' }}
        selected={selected}
        onRowClick={(p) => setSelected((s) => (s === p.login ? null : p.login))}
        renderExpanded={(p) => (
          <div style={{ padding: '6px 4px' }}>
            <TimeChart
              data={p.series}
              granularity={g}
              stacked={false}
              height={200}
              series={[
                { key: 'reviewed', label: 'PRs reviewed', color: c.s1, type: 'line' },
                { key: 'requested', label: 'Asked to review', color: c.s3, type: 'line' },
                { key: 'authored', label: 'PRs opened', color: c.s7, type: 'line' },
                { key: 'merged', label: 'PRs merged', color: c.s4, type: 'line' },
              ]}
            />
          </div>
        )}
        empty="No human review activity in this period."
      />
    </>
  );
}

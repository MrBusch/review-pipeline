import React, { useMemo } from 'react';
import { Card, TimeChart, useColors, SLOTS } from './charts';
import { SortTable } from './People';
import { fmtNum } from './util';

export default function Bots({ m }) {
  const c = useColors();
  const g = m.range.granularity;
  const active = m.bots.filter((b) => b.prsReviewed || b.requested);
  const top = active.filter((b) => b.prsReviewed).slice(0, 7);

  const data = useMemo(
    () =>
      m.buckets.map((bucket, i) => {
        const row = { bucket };
        top.forEach((b, j) => (row[`b${j}`] = b.series[i]));
        const all = m.bots.reduce((s, b) => s + b.series[i], 0);
        row.other = all - top.reduce((s, b) => s + b.series[i], 0);
        return row;
      }),
    [m, top]
  );

  const t = m.totals.current;

  return (
    <>
      <div className="stat-row">
        <div className="kpi">
          <div className="kpi-label">Bot reviews</div>
          <div className="kpi-value">{fmtNum(t.botReviews)}</div>
          <div className="kpi-delta">vs {fmtNum(t.humanReviews)} by people</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Merged with bot approval only</div>
          <div className="kpi-value">{fmtNum(t.mergedBotOnly)}</div>
          <div className="kpi-delta">of {fmtNum(t.merged)} merged PRs ({t.botOnlyShare ?? 0}%)</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Merged with a person's approval</div>
          <div className="kpi-value">{fmtNum(t.mergedHuman)}</div>
          <div className="kpi-delta">{fmtNum(t.mergedNoApproval)} merged without any approval</div>
        </div>
      </div>

      <div className="grid-2">
        <Card title="Bot reviews over time" sub="PRs reviewed by each bot.">
          <TimeChart
            data={data}
            granularity={g}
            series={[...top.map((b, j) => ({ key: `b${j}`, label: b.login, color: c[SLOTS[j]] })), ...(data.some((r) => r.other) ? [{ key: 'other', label: 'Other bots', color: c['s-other'] }] : [])]}
          />
        </Card>
        <Card title="How merged PRs were approved" sub="Approvals given before the merge.">
          <TimeChart
            data={m.series}
            granularity={g}
            series={[
              { key: 'mergedHuman', label: 'By a person', color: c.s1 },
              { key: 'mergedBotOnly', label: 'By bots only', color: c.s2 },
              { key: 'mergedNoApproval', label: 'No approval', color: c['s-other'] },
            ]}
            foot={(r) => (r.merged ? `${r.botOnlyShare}% bot-only` : null)}
          />
        </Card>
      </div>

      <div className="section-title">Bots</div>
      <p className="explain">
        Accounts GitHub marks as bots, plus any you list under Settings → Count as bots. A service account that GitHub reports as a normal user shows up under
        People until you add it there.
      </p>
      <SortTable
        rowKey={(b) => b.login}
        rows={active}
        initialSort={{ key: 'prsReviewed', dir: 'desc' }}
        empty="No bot activity in this period."
        columns={[
          { key: 'login', label: 'Bot', render: (b) => <span className="strong">{b.login}</span> },
          { key: 'requested', label: 'Requested', num: true, hint: 'Times someone requested a review from this bot.', render: (b) => fmtNum(b.requested) },
          { key: 'prsReviewed', label: 'PRs reviewed', num: true, render: (b) => fmtNum(b.prsReviewed) },
          { key: 'approvals', label: 'Approved', num: true, render: (b) => fmtNum(b.approvals) },
          { key: 'changesRequested', label: 'Changes req.', num: true, render: (b) => fmtNum(b.changesRequested) },
          { key: 'commentOnly', label: 'Comments only', num: true, render: (b) => fmtNum(b.commentOnly) },
          {
            key: 'soleApprovals',
            label: 'Merged on its approval alone',
            num: true,
            hint: 'Merged PRs where only bots approved, and this bot was one of them.',
            render: (b) => fmtNum(b.soleApprovals),
          },
        ]}
      />
    </>
  );
}

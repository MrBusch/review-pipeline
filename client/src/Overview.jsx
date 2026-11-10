import React from 'react';
import { Card, TimeChart, useColors } from './charts';
import { fmtHours, fmtNum, fmtPct } from './util';

// better: 'up' | 'down' | null (null = no judgement, just show the change)
function Kpi({ label, value, prev, format = fmtNum, better = null, hint }) {
  let delta = null;
  if (value != null && prev != null && prev !== 0) {
    const pct = Math.round(((value - prev) / Math.abs(prev)) * 100);
    const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : null;
    const cls = !dir || !better ? '' : dir === better ? `${dir}-good` : `${dir}-bad`;
    delta = (
      <>
        <span className={cls}>
          {pct > 0 ? '▲' : pct < 0 ? '▼' : '='} {Math.abs(pct)}%
        </span>{' '}
        vs {format(prev)} the period before
      </>
    );
  } else if (prev != null) delta = <>{format(prev)} the period before</>;
  return (
    <div className="kpi" title={hint}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{format(value)}</div>
      <div className="kpi-delta">{delta || ' '}</div>
    </div>
  );
}

export default function Overview({ m }) {
  const c = useColors();
  const cur = m.totals.current;
  const prev = m.totals.previous;
  const g = m.range.granularity;
  const per = g === 'month' ? 'month' : 'week';

  return (
    <>
      <div className="kpis">
        <Kpi label="PRs opened" value={cur.opened} prev={prev.opened} hint="Pull requests created in the period, including bot-authored ones." />
        <Kpi label="PRs merged" value={cur.merged} prev={prev.merged} />
        <Kpi
          label="Human reviews"
          value={cur.humanReviews}
          prev={prev.humanReviews}
          hint="PRs reviewed by a person other than the author (one per reviewer per PR)."
        />
        <Kpi
          label="Merged with bot approval only"
          value={cur.botOnlyShare}
          prev={prev.botOnlyShare}
          format={fmtPct}
          hint="Share of merged PRs whose only approvals came from bots."
        />
        <Kpi
          label="Median time to first human review"
          value={cur.medianFirstReviewH}
          prev={prev.medianFirstReviewH}
          format={fmtHours}
          better="down"
          hint="From ready for review to the first review by a person other than the author. Wall-clock time, nights and weekends included."
        />
        <Kpi
          label="Median time to merge"
          value={cur.medianMergeH}
          prev={prev.medianMergeH}
          format={fmtHours}
          better="down"
          hint="From ready for review to merged."
        />
      </div>

      <div className="grid-2">
        <Card title={`Pull requests per ${per}`} sub="How much work is flowing through review.">
          <TimeChart
            data={m.series}
            granularity={g}
            stacked={false}
            series={[
              { key: 'opened', label: 'Opened', color: c.s1, type: 'line' },
              { key: 'merged', label: 'Merged', color: c.s3, type: 'line' },
            ]}
            foot={(r) => (r.openedByBots ? `${r.openedByBots} opened by bots` : null)}
          />
        </Card>
        <Card title="How merged PRs were approved" sub="Approvals given before the merge. Human wins when both a person and a bot approved.">
          <TimeChart
            data={m.series}
            granularity={g}
            series={[
              { key: 'mergedHuman', label: 'Approved by a person', color: c.s1 },
              { key: 'mergedBotOnly', label: 'Approved by bots only', color: c.s2 },
              { key: 'mergedNoApproval', label: 'No approval', color: c['s-other'] },
            ]}
            foot={(r) => (r.merged ? `${r.merged} merged · ${r.botOnlyShare}% bot-only` : null)}
          />
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Reviews" sub="PRs reviewed, one per reviewer per PR. People vs bots.">
          <TimeChart
            data={m.series}
            granularity={g}
            series={[
              { key: 'humanReviews', label: 'By people', color: c.s1 },
              { key: 'botReviews', label: 'By bots', color: c.s2 },
            ]}
            foot={(r) => `Approvals: ${r.humanApprovals} by people, ${r.botApprovals} by bots`}
          />
        </Card>
        <Card title="Review requests" sub="Each time someone asked for a review (re-requests count again).">
          <TimeChart
            data={m.series}
            granularity={g}
            series={[
              { key: 'requestsToPeople', label: 'To people', color: c.s1 },
              { key: 'requestsToBots', label: 'To bots', color: c.s2 },
              { key: 'requestsToTeams', label: 'To teams', color: c.s3 },
            ]}
          />
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Share of merges approved by bots only" sub="How much of what ships relies on automated approval.">
          <TimeChart
            data={m.series}
            granularity={g}
            stacked={false}
            yFormat={fmtPct}
            yDomain={[0, 100]}
            series={[{ key: 'botOnlyShare', label: 'Bot-only approval share', color: c.s2, type: 'line' }]}
            foot={(r) => (r.merged ? `${r.mergedBotOnly} of ${r.merged} merged PRs${r.mergedNoApproval ? ` · ${r.mergedNoApproval} without approval` : ''}` : 'No merges')}
          />
        </Card>
        <Card title="Waiting times (median)" sub="Ready for review → first human review, and → merged. Wall-clock hours.">
          <TimeChart
            data={m.series}
            granularity={g}
            stacked={false}
            yFormat={fmtHours}
            series={[
              { key: 'medianFirstReviewH', label: 'To first human review', color: c.s1, type: 'line', format: fmtHours },
              { key: 'medianMergeH', label: 'To merge', color: c.s3, type: 'line', format: fmtHours },
            ]}
          />
        </Card>
      </div>
    </>
  );
}

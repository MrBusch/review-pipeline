import React, { useMemo } from 'react';
import { Card, BarList, useColors } from './charts';
import { fmtNum } from './util';

const LIMIT = 16;

export default function Requests({ m }) {
  const c = useColors();
  const { requesters, reviewers, cells } = m.matrix;

  const grid = useMemo(() => {
    const map = new Map(cells.map(([a, b, n]) => [`${a}\t${b}`, n]));
    const rows = requesters.slice(0, LIMIT);
    const cols = reviewers.slice(0, LIMIT);
    const max = Math.max(1, ...cells.map((x) => x[2]));
    const rowTotal = (a) => cells.filter((x) => x[0] === a).reduce((s, x) => s + x[2], 0);
    const colTotal = (b) => cells.filter((x) => x[1] === b).reduce((s, x) => s + x[2], 0);
    return { map, rows, cols, max, rowTotal, colTotal };
  }, [requesters, reviewers, cells]);

  // Sequential blue, light → dark. Square-root scale so a few very busy pairs don't wash out the rest.
  const cellStyle = (n) => {
    if (!n) return { background: c['seq-0'] };
    const step = Math.min(7, 1 + Math.floor(Math.sqrt(n / grid.max) * 6.999));
    return { background: c[`seq-${step}`], color: step >= 4 ? '#fff' : '#0b0b0b' };
  };

  const sent = m.people.filter((p) => p.requestsSent).sort((a, b) => b.requestsSent - a.requestsSent).slice(0, 15);
  const received = m.people.filter((p) => p.requestsReceived).sort((a, b) => b.requestsReceived - a.requestsReceived).slice(0, 15);

  return (
    <>
      <Card
        title="Who asks whom for reviews"
        sub={`Rows ask, columns are asked. Review requests between people in this period${requesters.length > LIMIT || reviewers.length > LIMIT ? `, top ${LIMIT} each way` : ''}. Hover a cell for details.`}
      >
        {!cells.length ? (
          <div className="empty-state">No review requests between people in this period.</div>
        ) : (
          <div className="heatmap-wrap">
            <table className="heatmap">
              <thead>
                <tr>
                  <th className="row dim small">asked by ↓ · asked to review →</th>
                  {grid.cols.map((b) => (
                    <th key={b} className="col">
                      {b}
                    </th>
                  ))}
                  <th className="col">Total sent</th>
                </tr>
              </thead>
              <tbody>
                {grid.rows.map((a) => (
                  <tr key={a}>
                    <th className="row">{a}</th>
                    {grid.cols.map((b) => {
                      const n = grid.map.get(`${a}\t${b}`) || 0;
                      return (
                        <td key={b} className={a === b ? 'self' : ''} style={a === b ? undefined : cellStyle(n)} title={n ? `${a} asked ${b} for a review ${n} time${n === 1 ? '' : 's'}` : `${a} → ${b}: none`}>
                          {n || ''}
                        </td>
                      );
                    })}
                    <td className="total num">{fmtNum(grid.rowTotal(a))}</td>
                  </tr>
                ))}
                <tr>
                  <th className="row">Total received</th>
                  {grid.cols.map((b) => (
                    <td key={b} className="total">
                      {fmtNum(grid.colTotal(b))}
                    </td>
                  ))}
                  <td className="total" />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid-2" style={{ marginTop: 14 }}>
        <Card title="Asks for the most reviews" sub="Review requests sent to other people.">
          <BarList rows={sent.map((p) => ({ label: p.login, value: p.requestsSent, hint: `${p.authored} PRs opened` }))} color={c.s1} />
        </Card>
        <Card title="Gets asked the most" sub="Review requests received from other people.">
          <BarList rows={received.map((p) => ({ label: p.login, value: p.requestsReceived, hint: `reviewed ${p.prsReviewed} PRs` }))} color={c.s3} />
        </Card>
      </div>

      {m.teams.length > 0 && (
        <Card title="Requests to teams" sub="Review requests sent to a GitHub team rather than a person.">
          <BarList rows={m.teams.map((t) => ({ label: t.team, value: t.n }))} color={c.s3} />
        </Card>
      )}
    </>
  );
}

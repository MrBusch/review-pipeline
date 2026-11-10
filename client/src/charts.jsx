import React, { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { fmtBucket, fmtBucketLong, fmtNum } from './util';

// ─── Theme-aware colors ───────────────────────────────────────────────────────
// Chart colors are CSS tokens (styles.css). SVG attributes can't always resolve var(), so read the
// computed values and re-read them whenever the theme changes.

const TOKENS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's-other', 'grid', 'axis', 'surface', 'text-dim', 'seq-0', 'seq-1', 'seq-2', 'seq-3', 'seq-4', 'seq-5', 'seq-6', 'seq-7'];

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries(TOKENS.map((t) => [t, cs.getPropertyValue(`--${t}`).trim()]));
}

export function useColors() {
  const [colors, setColors] = useState(readColors);
  useEffect(() => {
    const update = () => setColors(readColors());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', update);
    return () => {
      mo.disconnect();
      mq.removeEventListener('change', update);
    };
  }, []);
  return colors;
}

// Fixed categorical order. Entities keep their slot (color follows the entity, never its rank).
export const SLOTS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];

// ─── Building blocks ──────────────────────────────────────────────────────────

export function Card({ title, sub, right, children }) {
  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">{title}</div>
        {right}
      </div>
      {sub && <div className="card-sub">{sub}</div>}
      {children}
    </div>
  );
}

// Static legend, or an interactive one when `onToggle` is given: click hides or shows an item,
// shift- or alt-click shows only that item.
export function Legend({ items, onToggle, onShowAll }) {
  const interactive = !!onToggle;
  return (
    <div className="legend">
      {items.map((it) =>
        interactive ? (
          <button
            key={it.label}
            type="button"
            className={`legend-item legend-toggle${it.hidden ? ' off' : ''}`}
            aria-pressed={!it.hidden}
            title="Click to hide or show. Shift-click to show only this."
            onClick={(e) => onToggle(it.label, e.shiftKey || e.altKey)}
          >
            <span className={`swatch${it.line ? ' line' : ''}`} style={{ background: it.color }} />
            {it.label}
          </button>
        ) : (
          <span key={it.label} className="legend-item">
            <span className={`swatch${it.line ? ' line' : ''}`} style={{ background: it.color }} />
            {it.label}
          </span>
        )
      )}
      {interactive && items.some((it) => it.hidden) && (
        <button type="button" className="legend-reset" onClick={onShowAll}>
          Show all
        </button>
      )}
    </div>
  );
}

// Which series of a chart are hidden. Keyed by label so a choice survives changing the date range.
export function useHiddenSeries(labels) {
  const [hidden, setHidden] = useState(() => new Set());
  // Forget labels that left the chart (for example a reviewer outside the new range).
  const live = useMemo(() => new Set([...hidden].filter((l) => labels.includes(l))), [hidden, labels]);
  const toggle = (label, solo) => {
    setHidden(() => {
      if (solo) {
        const onlyThis = labels.every((l) => (l === label) !== live.has(l));
        // Shift-clicking the item that is already shown alone brings everything back.
        return onlyThis ? new Set() : new Set(labels.filter((l) => l !== label));
      }
      const next = new Set(live);
      if (next.has(label)) next.delete(label);
      else if (next.size < labels.length - 1) next.add(label); // keep at least one visible
      return next;
    });
  };
  return { hidden: live, toggle, showAll: () => setHidden(new Set()) };
}

function TipBox({ title, rows, foot }) {
  return (
    <div className="chart-tip">
      <div className="chart-tip-title">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="chart-tip-row">
          <span className={`swatch${r.line ? ' line' : ''}`} style={{ background: r.color }} />
          <span>{r.label}</span>
          <span className="val">{r.value}</span>
        </div>
      ))}
      {foot && <div className="chart-tip-foot">{foot}</div>}
    </div>
  );
}

// ─── Time series ──────────────────────────────────────────────────────────────
// series: [{ key, label, color, type: 'bar' | 'line', format? }]
// Bars stack in the order given (first at the bottom). One y-axis only.

export function TimeChart({ data, granularity, series, height = 220, yFormat = fmtNum, foot, stacked = true, yDomain }) {
  const c = useColors();
  const labelKey = series.map((s) => s.label).join('\n');
  const labels = useMemo(() => labelKey.split('\n'), [labelKey]);
  const { hidden, toggle, showAll } = useHiddenSeries(labels);
  const visible = series.filter((s) => !hidden.has(s.label));
  const bars = visible.filter((s) => s.type !== 'line');
  const lines = visible.filter((s) => s.type === 'line');
  const fmt = (s, v) => (v == null ? '–' : (s.format || yFormat)(v));
  const tickEvery = Math.max(1, Math.ceil(data.length / 12));

  const renderTip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const row = payload[0].payload;
    // List tooltip rows top-down in the same order the stack draws, top segment first.
    const rows = [...lines, ...[...bars].reverse()].map((s) => ({ label: s.label, color: s.color, line: s.type === 'line', value: fmt(s, row[s.key]) }));
    return <TipBox title={fmtBucketLong(label, granularity)} rows={rows} foot={foot?.(row)} />;
  };

  return (
    <>
      <Legend
        items={series.map((s) => ({ label: s.label, color: s.color, line: s.type === 'line', hidden: hidden.has(s.label) }))}
        onToggle={series.length > 1 ? toggle : undefined}
        onShowAll={showAll}
      />
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: -8 }} barCategoryGap="18%">
          <CartesianGrid vertical={false} stroke={c.grid} />
          <XAxis
            dataKey="bucket"
            tickFormatter={(k) => fmtBucket(k, granularity)}
            interval={tickEvery - 1}
            tickLine={false}
            axisLine={{ stroke: c.grid }}
            tick={{ fill: c.axis, fontSize: 11 }}
            minTickGap={8}
          />
          <YAxis tickFormatter={yFormat} tickLine={false} axisLine={false} tick={{ fill: c.axis, fontSize: 11 }} width={48} allowDecimals={false} domain={yDomain} />
          <Tooltip content={renderTip} cursor={{ fill: c['text-dim'], opacity: 0.08 }} isAnimationActive={false} />
          {bars.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId={stacked ? 'a' : undefined}
              fill={s.color}
              stroke={c.surface}
              strokeWidth={stacked && bars.length > 1 ? 1 : 0}
              radius={!stacked || i === bars.length - 1 ? [4, 4, 0, 0] : 0}
              isAnimationActive={false}
              maxBarSize={36}
            />
          ))}
          {lines.map((s) => (
            <Line
              key={s.key}
              dataKey={s.key}
              stroke={s.color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: c.surface, strokeWidth: 2 }}
              connectNulls
              isAnimationActive={false}
              type="monotone"
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </>
  );
}

// Horizontal bars for a ranked list (people, bots). Plain HTML, one value per row.
export function BarList({ rows, color, format = fmtNum, max }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="bar-list">
      {rows.map((r) => (
        <div key={r.label} className="bar-row" title={`${r.label}: ${format(r.value)}${r.hint ? ` — ${r.hint}` : ''}`}>
          <span className="truncate">{r.label}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(100 * r.value) / top}%`, background: r.color || color }} />
          </div>
          <span className="num">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

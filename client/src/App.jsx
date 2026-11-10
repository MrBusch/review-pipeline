import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { ThemeSwitch } from './theme';
import Overview from './Overview';
import People from './People';
import Requests from './Requests';
import Bots from './Bots';
import Queue from './Queue';
import { AddRepoDialog, SettingsDialog } from './Settings';
import { ago, fmtNum, isoDay, loadPref, monthsAgo, savePref, snapToBucket } from './util';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'people', label: 'People' },
  { key: 'requests', label: 'Requests' },
  { key: 'bots', label: 'Bots' },
  { key: 'queue', label: 'Open queue' },
];

const PRESETS = [
  { key: '1m', label: '1 month', months: 1 },
  { key: '3m', label: '3 months', months: 3 },
  { key: '6m', label: '6 months', months: 6 },
  { key: '12m', label: '12 months', months: 12 },
  { key: 'all', label: 'All' },
  { key: 'custom', label: 'Custom' },
];

function Icon() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="var(--accent)" />
      <g fill="#fff">
        <rect x="7" y="17" width="4" height="8" rx="1.5" />
        <rect x="14" y="12" width="4" height="13" rx="1.5" />
        <rect x="21" y="7" width="4" height="18" rx="1.5" />
      </g>
    </svg>
  );
}

function Definitions() {
  return (
    <details className="explain" style={{ marginTop: 24 }}>
      <summary>How these numbers are counted</summary>
      <ul>
        <li>
          <b>Bots</b> are accounts GitHub marks as bots (for example cursor and copilot-pull-request-reviewer), logins ending in [bot], and logins you add in
          Settings.
        </li>
        <li>
          <b>A review</b> is a review left on someone else's PR. Authors replying in their own review threads are left out. Several reviews by one person on
          one PR count once.
        </li>
        <li>
          <b>A review request</b> is GitHub's "requested a review" event. Asking the same person again after changes counts again. Requests made
          automatically through CODEOWNERS are credited to whoever GitHub records, usually the PR author.
        </li>
        <li>
          <b>Approved by bots only</b>: a merged PR where every approval before the merge came from a bot.
        </li>
        <li>
          <b>Times</b> are wall-clock (nights and weekends included), measured from when the PR became ready for review. Medians are used so a few stale PRs
          don't skew them.
        </li>
        <li>Opened counts by creation date, merged by merge date, reviews and requests by when they happened. Weeks start on Monday (UTC).</li>
      </ul>
    </details>
  );
}

export default function App() {
  const [repos, setRepos] = useState([]);
  const [database, setDatabase] = useState('');
  const [selected, setSelected] = useState(() => loadPref('repos', null));
  const [range, setRange] = useState(() => loadPref('range', { preset: '6m', from: monthsAgo(6), to: isoDay(new Date()) }));
  const [granularity, setGranularity] = useState(() => loadPref('granularity', 'week'));
  const [tab, setTab] = useState(() => {
    const h = window.location.hash.slice(1);
    return TABS.some((t) => t.key === h) ? h : loadPref('tab', 'overview');
  });
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sync, setSync] = useState(null);
  const [github, setGithub] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => savePref('repos', selected), [selected]);
  useEffect(() => savePref('range', range), [range]);
  useEffect(() => savePref('granularity', granularity), [granularity]);
  useEffect(() => {
    savePref('tab', tab);
    if (window.location.hash.slice(1) !== tab) window.history.replaceState(null, '', `#${tab}`);
  }, [tab]);

  const loadRepos = useCallback(async () => {
    const r = await api.repos();
    setRepos(r.repos);
    setDatabase(r.database);
    setLoaded(true);
    // Default to every repo; drop selections of removed repos.
    setSelected((sel) => {
      const ids = r.repos.map((x) => x.id);
      const kept = (sel || []).filter((id) => ids.includes(id));
      return kept.length ? kept : ids;
    });
    return r.repos;
  }, []);

  useEffect(() => {
    loadRepos().catch((e) => setError(e.message));
    api.syncStatus().then(setSync).catch(() => {});
    api.github().then(setGithub).catch(() => {});
  }, [loadRepos]);

  const activeRepos = useMemo(() => repos.filter((r) => selected?.includes(r.id)), [repos, selected]);

  // Resolve the date range; "All" starts at the earliest history of the selected repos.
  const effective = useMemo(() => {
    const today = isoDay(new Date());
    const p = PRESETS.find((x) => x.key === range.preset);
    if (range.preset === 'custom') return { from: range.from, to: range.to };
    if (range.preset === 'all') {
      const oldest = activeRepos.map((r) => r.backfill_since).sort()[0] || monthsAgo(12);
      return { from: snapToBucket(oldest, granularity), to: today };
    }
    // Start on a whole week (or month) so the first bar isn't a partial one.
    return { from: snapToBucket(monthsAgo(p?.months || 6), granularity), to: today };
  }, [range, activeRepos, granularity]);

  const requestId = useRef(0);
  const loadMetrics = useCallback(async () => {
    if (!activeRepos.length) {
      setMetrics(null);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    try {
      const m = await api.metrics({ repoIds: activeRepos.map((r) => r.id), ...effective, granularity });
      if (id === requestId.current) {
        setMetrics(m);
        setError(null);
      }
    } catch (e) {
      if (id === requestId.current) setError(e.message);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [activeRepos, effective, granularity]);

  useEffect(() => {
    loadMetrics();
  }, [loadMetrics]);

  // While a sync runs, poll its progress and refresh the charts now and then as data arrives.
  // A sync started from the command line holds the same lock; treat it like ours, minus progress.
  const external = !sync?.running && !!sync?.externalPid;
  const running = !!sync?.running || external;
  useEffect(() => {
    if (!running) return;
    let ticks = 0;
    const t = setInterval(async () => {
      const s = await api.syncStatus().catch(() => null);
      if (!s) return;
      setSync(s);
      ticks++;
      if (!s.running && !s.externalPid) {
        await loadRepos();
        loadMetrics();
      } else if (ticks % 8 === 0) {
        loadRepos();
        loadMetrics();
      }
    }, 2000);
    return () => clearInterval(t);
  }, [running, loadRepos, loadMetrics]);

  const startSync = async (repoIds) => {
    try {
      setSync(await api.sync(repoIds));
    } catch (e) {
      setError(e.message);
    }
  };

  const toggleRepo = (id) => setSelected((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]));

  const detectedBots = metrics?.bots.map((b) => b.login) || [];
  const neverSynced = activeRepos.some((r) => !r.last_synced_at);

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <Icon />
          Review Pipeline
        </div>
        <div className="sidebar-label">Repositories</div>
        <div className="repo-list">
          {loaded && !repos.length && <div className="side-note">No repositories yet. Add one to start.</div>}
          {repos.map((r) => {
            const s = sync?.running ? sync.repos?.[r.id] : null;
            const active = s && (s.state === 'running' || s.state === 'queued');
            const pct = s?.estimate ? Math.min(100, Math.round((100 * s.fetched) / s.estimate)) : 0;
            return (
              <label key={r.id} className="repo-check">
                <input type="checkbox" checked={!!selected?.includes(r.id)} onChange={() => toggleRepo(r.id)} />
                <div className="stack">
                  <span className="repo-name truncate" title={`${r.owner}/${r.name}`}>
                    {r.name}
                  </span>
                  <span className="dim small truncate">
                    {active
                      ? s.state === 'queued'
                        ? 'Waiting to sync…'
                        : `Syncing ${fmtNum(s.fetched)}${s.estimate ? ` of ~${fmtNum(s.estimate)}` : ''} PRs`
                      : `${fmtNum(r.pr_count)} PRs · synced ${ago(r.last_synced_at)}`}
                  </span>
                  {active && s.state === 'running' && (
                    <div className="progress">
                      <div style={{ width: `${pct}%` }} />
                    </div>
                  )}
                  {external && !r.last_synced_at && <span className="dim small">Syncing from the command line…</span>}
                  {active && s.message && <span className="small" style={{ color: 'var(--warn)' }}>{s.message}</span>}
                  {!active && !running && (sync?.repos?.[r.id]?.error || r.last_error) && <span className="error-text small">{sync?.repos?.[r.id]?.error || r.last_error}</span>}
                </div>
              </label>
            );
          })}
        </div>
        <div className="side-actions">
          <button className="btn btn-primary" disabled={running || !repos.length} onClick={() => startSync()}>
            {external ? 'Syncing (command line)…' : running ? 'Syncing…' : 'Sync now'}
          </button>
          <button className="btn" onClick={() => setDialog('add')}>
            Add repository
          </button>
          <button className="btn btn-ghost" onClick={() => setDialog('settings')}>
            Settings
          </button>
        </div>
        {github && (
          <div className={`side-note${github.ok ? '' : ' error'}`}>
            {github.ok ? `GitHub: signed in as ${github.login}` : github.error}
          </div>
        )}
        <ThemeSwitch />
      </aside>

      <main className="main">
        <div className="repo-head">
          <div>
            <h1>Review pipeline</h1>
            <div className="dim">
              {activeRepos.length ? activeRepos.map((r) => `${r.owner}/${r.name}`).join(', ') : 'No repository selected'} · {effective.from} to {effective.to}
            </div>
          </div>
        </div>

        <div className="toolbar">
          <div className="segmented" role="radiogroup" aria-label="Date range">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                className={range.preset === p.key ? 'active' : ''}
                onClick={() => setRange((r) => ({ ...r, preset: p.key, ...(p.key === 'custom' ? { from: effective.from, to: effective.to } : {}) }))}
              >
                {p.label}
              </button>
            ))}
          </div>
          {range.preset === 'custom' && (
            <span className="row" style={{ alignItems: 'center' }}>
              <input type="date" className="input date-input" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))} />
              <span className="dim">to</span>
              <input type="date" className="input date-input" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))} />
            </span>
          )}
          <div className="segmented push" role="radiogroup" aria-label="Group by">
            {['week', 'month'].map((g) => (
              <button key={g} className={granularity === g ? 'active' : ''} onClick={() => setGranularity(g)}>
                By {g}
              </button>
            ))}
          </div>
        </div>

        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`tab${tab === t.key ? ' active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        {loading && <div className="loading-bar" />}

        {error && <div className="empty-state error">{error}</div>}
        {loaded && !repos.length && (
          <div className="empty-state">
            <p>Add a GitHub repository to start pulling its pull request and review history.</p>
            <button className="btn btn-primary" onClick={() => setDialog('add')}>
              Add repository
            </button>
          </div>
        )}
        {repos.length > 0 && !activeRepos.length && <div className="empty-state">Pick at least one repository in the sidebar.</div>}
        {neverSynced && activeRepos.length > 0 && (
          <div className="banner">
            {activeRepos
              .filter((r) => !r.last_synced_at)
              .map((r) => (
                <span key={r.id}>
                  <b>{r.name}</b>: first sync {running ? 'in progress' : 'not finished'}
                  {r.watermark ? ` · has activity up to ${r.watermark.slice(0, 10)} so far` : ' · no data yet'}.{' '}
                </span>
              ))}
            {!running && (
              <button className="btn btn-sm btn-primary" onClick={() => startSync()}>
                {activeRepos.some((r) => r.watermark) ? 'Continue sync' : 'Sync now'}
              </button>
            )}
          </div>
        )}

        {metrics && activeRepos.length > 0 && (
          <>
            {tab === 'overview' && <Overview m={metrics} />}
            {tab === 'people' && <People m={metrics} />}
            {tab === 'requests' && <Requests m={metrics} />}
            {tab === 'bots' && <Bots m={metrics} />}
            {tab === 'queue' && <Queue m={metrics} multiRepo={activeRepos.length > 1} />}
            <Definitions />
          </>
        )}
      </main>

      {dialog === 'add' && (
        <AddRepoDialog
          onClose={() => setDialog(null)}
          onAdded={async (r) => {
            setDialog(null);
            await loadRepos();
            setSelected((sel) => [...new Set([...(sel || []), r.id])]);
            startSync([r.id]);
          }}
        />
      )}
      {dialog === 'settings' && (
        <SettingsDialog
          repos={repos}
          database={database}
          syncing={running}
          detectedBots={detectedBots}
          onClose={() => setDialog(null)}
          onChanged={async () => {
            await loadRepos();
            loadMetrics();
          }}
        />
      )}
    </div>
  );
}

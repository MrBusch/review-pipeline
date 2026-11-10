import React, { useEffect, useState } from 'react';
import { api } from './api';
import { ago, fmtNum, monthsAgo } from './util';

const HISTORY = [
  { label: '3 months', months: 3 },
  { label: '6 months', months: 6 },
  { label: '12 months', months: 12 },
  { label: '24 months', months: 24 },
];

export function AddRepoDialog({ onClose, onAdded }) {
  const [repo, setRepo] = useState('');
  const [months, setMonths] = useState(12);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.addRepo(repo, monthsAgo(months));
      onAdded(r);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <div className="modal-head">
          <h2>Add a repository</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="dim">Enter it as OWNER/NAME or paste its GitHub URL. Your GitHub CLI login needs read access to it.</p>
          <input className="input mono" autoFocus placeholder="octocat/Hello-World" value={repo} onChange={(e) => setRepo(e.target.value)} />
          <div className="section-title">How much history to pull</div>
          <div className="segmented">
            {HISTORY.map((h) => (
              <button type="button" key={h.months} className={months === h.months ? 'active' : ''} onClick={() => setMonths(h.months)}>
                {h.label}
              </button>
            ))}
          </div>
          <p className="dim small">
            The first sync pulls every PR active since {monthsAgo(months)}. For a busy repo, 12 months takes roughly 15 minutes. Later syncs only fetch
            what changed.
          </p>
          {error && <p className="error-text">{error}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !repo.trim()}>
            {busy ? 'Checking…' : 'Add and sync'}
          </button>
        </div>
      </form>
    </div>
  );
}

const toList = (s) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim().replace(/^@/, ''))
    .filter(Boolean);

export function SettingsDialog({ repos, database, syncing, onClose, onChanged, detectedBots }) {
  const [settings, setSettings] = useState(null);
  const [bots, setBots] = useState('');
  const [ignored, setIgnored] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.settings().then((s) => {
      setSettings(s);
      setBots(s.extraBots.join('\n'));
      setIgnored(s.ignored.join('\n'));
    });
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveSettings({ extraBots: toList(bots), ignored: toList(ignored) });
      onChanged();
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const act = async (fn) => {
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 680 }}>
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="section-title" style={{ marginTop: 0 }}>
            Repositories
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>History from</th>
                  <th className="num">PRs stored</th>
                  <th>Last sync</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {!repos.length && (
                  <tr>
                    <td colSpan={5} className="empty dim">
                      No repositories yet.
                    </td>
                  </tr>
                )}
                {repos.map((r) => (
                  <tr key={r.id}>
                    <td className="strong">
                      {r.owner}/{r.name}
                      {r.last_error && <div className="error-text">{r.last_error}</div>}
                    </td>
                    <td className="nowrap">{r.backfill_since}</td>
                    <td className="num">{fmtNum(r.pr_count)}</td>
                    <td className="nowrap dim">{ago(r.last_synced_at)}</td>
                    <td className="actions">
                      <button
                        className="btn btn-sm"
                        disabled={syncing}
                        title="Forget the sync position and pull the whole history again on the next sync."
                        onClick={() => {
                          const since = window.prompt(`Pull ${r.owner}/${r.name} again from which date? (YYYY-MM-DD)`, r.backfill_since);
                          if (since) act(() => api.resetRepo(r.id, since));
                        }}
                      >
                        Re-pull…
                      </button>
                      <button
                        className="btn btn-sm btn-danger-ghost"
                        disabled={syncing}
                        onClick={() => window.confirm(`Remove ${r.owner}/${r.name} and its stored data?`) && act(() => api.removeRepo(r.id))}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="section-title">Count as bots</div>
          <p className="dim small" style={{ marginTop: 0 }}>
            GitHub already marks app accounts as bots
            {detectedBots?.length ? ` (seen so far: ${detectedBots.join(', ')})` : ''}. Add service accounts that log in as normal users. One login per line.
          </p>
          <textarea className="input textarea" value={bots} onChange={(e) => setBots(e.target.value)} disabled={!settings} placeholder="ci-service-account" />

          <div className="section-title">Leave out of all metrics</div>
          <p className="dim small" style={{ marginTop: 0 }}>
            Logins whose PRs, reviews and requests should be ignored entirely. One per line.
          </p>
          <textarea className="input textarea" value={ignored} onChange={(e) => setIgnored(e.target.value)} disabled={!settings} />

          <p className="dim small">
            Data is stored in <span className="mono">{database}</span>.
          </p>
          {error && <p className="error-text">{error}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !settings}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

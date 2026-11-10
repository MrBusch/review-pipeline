async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  repos: () => request('GET', '/api/repos'),
  addRepo: (repo, since) => request('POST', '/api/repos', { repo, since }),
  removeRepo: (id) => request('DELETE', `/api/repos/${id}`),
  resetRepo: (id, since) => request('POST', `/api/repos/${id}/reset`, { since }),
  sync: (repoIds) => request('POST', '/api/sync', { repoIds }),
  syncStatus: () => request('GET', '/api/sync'),
  github: () => request('GET', '/api/github'),
  settings: () => request('GET', '/api/settings'),
  saveSettings: (s) => request('PUT', '/api/settings', s),
  metrics: ({ repoIds, from, to, granularity }) =>
    request('GET', `/api/metrics?repos=${repoIds.join(',')}&from=${from}&to=${to}&granularity=${granularity}`),
};

import React, { useEffect, useState } from 'react';

// "auto" follows the system setting; "light" and "dark" override it. Stored per browser.
const KEY = 'review-pipeline-theme';

function readTheme() {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch {
    return 'auto';
  }
}

function applyTheme(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function useTheme() {
  const [theme, setTheme] = useState(readTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Keep other open tabs in step.
  useEffect(() => {
    const onStorage = (e) => e.key === KEY && setTheme(readTheme());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const choose = (t) => {
    setTheme(t);
    try {
      if (t === 'auto') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      // storage blocked; the choice still applies until reload
    }
  };
  return [theme, choose];
}

const ICONS = {
  auto: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
      <path d="M5.5 14h5M8 11.5V14" />
    </svg>
  ),
  light: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1" />
    </svg>
  ),
  dark: (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7Z" />
    </svg>
  ),
};

const LABELS = { auto: 'Auto', light: 'Light', dark: 'Dark' };
const TITLES = { auto: 'Follow the system setting', light: 'Always light', dark: 'Always dark' };

export function ThemeSwitch() {
  const [theme, choose] = useTheme();
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Color theme">
      {['auto', 'light', 'dark'].map((t) => (
        <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? 'active' : ''} title={TITLES[t]} onClick={() => choose(t)}>
          {ICONS[t]}
          {LABELS[t]}
        </button>
      ))}
    </div>
  );
}

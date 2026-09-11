/**
 * DamSafe Twin — Command-centre TopBar.
 * Search (Ctrl+K focuses, filters existing routes), System Online,
 * current operator, settings entry.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, Settings, Menu, ChevronDown, LogOut } from 'lucide-react';
import { NAV_ITEMS } from './nav';
import { useAuth } from '../../auth/AuthContext';

interface TopBarProps {
  onOpenMobileNav: () => void;
}

export default function TopBar({ onOpenMobileNav }: TopBarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);

  // Ctrl+K / Cmd+K focuses search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Close suggestions when clicking outside.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return NAV_ITEMS.filter((item) =>
      t(item.labelKey, { defaultValue: item.fallbackLabel }).toLowerCase().includes(q) ||
      item.fallbackLabel.toLowerCase().includes(q),
    ).slice(0, 6);
  }, [query, t]);

  const go = (path: string) => {
    navigate(path);
    setQuery('');
    setFocused(false);
    inputRef.current?.blur();
  };

  return (
    <header className="sticky top-0 z-30 border-b border-cmd-border bg-cmd-bg/95 backdrop-blur">
      <div className="flex h-16 items-center gap-3 px-4 md:px-6">
        <button
          onClick={onOpenMobileNav}
          aria-label="Open navigation"
          className="rounded-md p-2 text-cmd-muted hover:bg-white/[0.06] hover:text-cmd-ink lg:hidden"
        >
          <Menu className="h-5 w-5" strokeWidth={1.75} />
        </button>

        {/* Search */}
        <div ref={boxRef} className="relative w-full max-w-md">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-cmd-muted"
            strokeWidth={1.75}
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setFocused(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches.length > 0) go(matches[0].path);
              if (e.key === 'Escape') {
                setQuery('');
                inputRef.current?.blur();
              }
            }}
            type="text"
            role="combobox"
            aria-expanded={focused && matches.length > 0}
            aria-label="Search dams, locations, or actions"
            placeholder="Search dams, locations, or actions..."
            className="h-10 w-full rounded-lg border border-cmd-border bg-cmd-panel pl-9 pr-20 text-[13px] text-cmd-ink placeholder:text-cmd-muted/70 focus:border-cmd-teal/60 focus:outline-none"
          />
          <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-cmd-border bg-cmd-panel2 px-1.5 py-0.5 text-[11px] font-medium text-cmd-muted">
            Ctrl + K
          </kbd>

          {focused && matches.length > 0 && (
            <div className="absolute inset-x-0 top-11 overflow-hidden rounded-lg border border-cmd-border bg-cmd-panel2 shadow-xl">
              {matches.map((item) => (
                <button
                  key={item.path}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => go(item.path)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-[13px] text-cmd-ink hover:bg-white/[0.05]"
                >
                  <item.icon className="h-4 w-4 text-cmd-teal" strokeWidth={1.75} />
                  {t(item.labelKey, { defaultValue: item.fallbackLabel })}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2 md:gap-4">
          {/* System status */}
          <div className="hidden items-center gap-2 border-r border-cmd-border pr-4 sm:flex">
            <span className="h-2 w-2 rounded-full bg-cmd-green" />
            <span className="text-[13px] font-medium text-cmd-green">System Online</span>
          </div>

          {/* Operator */}
          {user ? (
            <div className="hidden items-center gap-2 text-[13px] sm:flex" title={`${user.designation || user.role}${user.dam_id ? ` • posted: ${user.dam_id}` : ''}`}>
              <span className="flex h-7 w-7 items-center justify-center rounded-full border border-cmd-teal/40 bg-cmd-tealdim font-bold text-cmd-teal text-xs">
                {user.name.charAt(0).toUpperCase()}
              </span>
              <span className="font-medium text-cmd-ink max-w-[140px] truncate">{user.name}</span>
              {user.dam_id && (
                <span className="px-1.5 py-0.5 rounded-md bg-cmd-teal/15 text-cmd-teal text-[10px] font-bold font-mono">{user.dam_id}</span>
              )}
              <button onClick={() => { logout(); navigate('/'); }} className="p-1.5 rounded-md text-cmd-muted hover:text-cmd-red" title="Sign out">
                <LogOut className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </div>
          ) : (
            <div className="hidden items-center gap-2 text-[13px] sm:flex">
              <span className="flex h-7 w-7 items-center justify-center rounded-full border border-cmd-border bg-cmd-panel2 text-cmd-muted">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.75}>
                  <circle cx="12" cy="8" r="3.5" />
                  <path d="M5 20c1.2-3.2 3.9-5 7-5s5.8 1.8 7 5" />
                </svg>
              </span>
              <span className="font-medium text-cmd-ink">Dev Operator</span>
              <Link to="/login" className="px-2.5 py-1 rounded-md bg-cmd-teal/90 text-[#071018] text-[11px] font-bold hover:bg-cmd-teal">
                Sign in
              </Link>
            </div>
          )}

          <button
            aria-label="Settings"
            title="Settings"
            className="rounded-md p-2 text-cmd-muted transition-colors hover:bg-white/[0.06] hover:text-cmd-ink"
          >
            <Settings className="h-5 w-5" strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </header>
  );
}

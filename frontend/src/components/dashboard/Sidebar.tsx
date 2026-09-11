/**
 * AquaShield 3D — Command-centre Sidebar.
 * Fixed 288px rail: logo, nav (subtle dark-teal active state),
 * language selector + system/version footer.
 */

import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Shield, Globe, X } from 'lucide-react';
import { NAV_ITEMS } from './nav';
import { useAuth } from '../../auth/AuthContext';

interface SidebarProps {
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

function SidebarBody({ onNavigate }: { onNavigate: () => void }) {
  const { t, i18n } = useTranslation();
  const { isAdmin, user, scopeDamId } = useAuth();

  const toggleLanguage = () => {
    i18n.changeLanguage(i18n.language === 'en' ? 'hi' : 'en');
  };
  const items = NAV_ITEMS.filter((n) => !n.adminOnly || isAdmin);

  return (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div className="px-5 pb-5 pt-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-cmd-border bg-cmd-panel2">
            <Shield className="h-5 w-5 text-cmd-teal" strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[17px] font-semibold leading-tight text-cmd-ink">
              AquaShield 3D
            </p>
            <p className="mt-0.5 text-xs text-cmd-muted">EAP Platform v1.0</p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-3" aria-label="Primary">
        {items.map(({ path, labelKey, fallbackLabel, icon: Icon }) => (
          <NavLink
            key={path}
            to={path}
            onClick={onNavigate}
            className={({ isActive }) =>
              `relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13.5px] font-medium transition-colors ${
                isActive
                  ? 'bg-cmd-tealdim text-cmd-ink'
                  : 'text-cmd-muted hover:bg-white/[0.04] hover:text-cmd-ink'
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <span className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-cmd-teal" />
                )}
                <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />
                <span className="truncate">{t(labelKey, { defaultValue: fallbackLabel })}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="space-y-3 px-3 pb-5 pt-4">
        <button
          onClick={toggleLanguage}
          className="flex w-full items-center gap-3 rounded-lg border-t border-cmd-border px-3 pb-1 pt-4 text-[13.5px] font-medium text-cmd-muted transition-colors hover:text-cmd-ink"
        >
          <Globe className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />
          <span>{i18n.language === 'en' ? 'English' : 'हिन्दी'}</span>
          <span className="ml-auto text-[11px] text-cmd-muted/70">
            {i18n.language === 'en' ? 'EN' : 'HI'}
          </span>
        </button>
        <div className="flex items-center gap-2 px-3 text-xs">
          <span className="h-1.5 w-1.5 rounded-full bg-cmd-green" />
          <span className="text-cmd-green truncate">
            {user ? `${user.name.split(' ')[0]}${scopeDamId ? ` • ${scopeDamId}` : ''}` : 'System Online'}
          </span>
          <span className="ml-auto text-cmd-muted/70 shrink-0">v1.0.0</span>
        </div>
      </div>
    </div>
  );
}

export default function Sidebar({ mobileOpen, onCloseMobile }: SidebarProps) {
  return (
    <>
      {/* Desktop rail */}
      <aside className="hidden w-72 shrink-0 border-r border-cmd-border bg-[#0A1218] lg:block">
        <SidebarBody onNavigate={() => undefined} />
      </aside>

      {/* Mobile drawer */}
      <div
        className={`fixed inset-0 z-40 bg-black/60 transition-opacity lg:hidden ${
          mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={onCloseMobile}
        aria-hidden="true"
      />
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-72 border-r border-cmd-border bg-[#0A1218] transition-transform duration-200 lg:hidden ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <button
          onClick={onCloseMobile}
          aria-label="Close navigation"
          className="absolute right-3 top-5 rounded-md p-1.5 text-cmd-muted hover:bg-white/[0.06] hover:text-cmd-ink"
        >
          <X className="h-5 w-5" strokeWidth={1.75} />
        </button>
        <SidebarBody onNavigate={onCloseMobile} />
      </aside>
    </>
  );
}


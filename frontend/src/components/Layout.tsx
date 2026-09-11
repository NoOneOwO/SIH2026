/**
 * AquaShield 3D — Layout (command-centre shell).
 * Dark ops chrome: Sidebar rail + TopBar + content outlet.
 * Routes, i18n and auth behaviour unchanged — presentation only.
 */

import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './dashboard/Sidebar';
import TopBar from './dashboard/TopBar';

export default function Layout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-cmd-bg text-cmd-ink">
      <Sidebar mobileOpen={mobileNavOpen} onCloseMobile={() => setMobileNavOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenMobileNav={() => setMobileNavOpen(true)} />
        {/* Command-centre content well: every module renders on the dark ops
            theme. Dashboard paints its own full-bleed bg inside this. */}
        <main className="min-h-0 flex-1 overflow-hidden bg-cmd-bg">
          <div className="h-full w-full">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}


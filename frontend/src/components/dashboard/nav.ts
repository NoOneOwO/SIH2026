/**
 * AquaShield 3D — Command-centre navigation definition.
 * Single source of truth for Sidebar + TopBar search.
 */

import {
  House, Zap, Shield, AlertTriangle,
  Users, FileText, Bot, ShieldCheck, Waves,
} from 'lucide-react';

export interface NavItem {
  path: string;
  labelKey: string;
  fallbackLabel: string;
  icon: typeof House;
  adminOnly?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { path: '/dashboard', labelKey: 'nav.dashboard', fallbackLabel: 'Dashboard', icon: House },
  { path: '/impact', labelKey: 'nav.floodImpact', fallbackLabel: 'Flood Impact', icon: Waves },
  { path: '/incident', labelKey: 'nav.incidentConsole', fallbackLabel: 'Incident Console', icon: Zap },
  { path: '/eap', labelKey: 'nav.eapDashboard', fallbackLabel: 'EAP Dashboard', icon: Shield },
  { path: '/alerts', labelKey: 'nav.alertConsole', fallbackLabel: 'Alert Console', icon: AlertTriangle },
  { path: '/evacuation', labelKey: 'nav.evacuationPlanner', fallbackLabel: 'Evacuation Planner', icon: Users },
  { path: '/reports', labelKey: 'nav.reportGenerator', fallbackLabel: 'Report Generator', icon: FileText },
  { path: '/assistant', labelKey: 'nav.assistant', fallbackLabel: 'AI Assistant', icon: Bot },
  { path: '/admin', labelKey: 'nav.admin', fallbackLabel: 'Admin', icon: ShieldCheck, adminOnly: true },
];


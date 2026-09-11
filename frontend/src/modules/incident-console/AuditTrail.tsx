/**
 * DamSafe Twin — Audit Trail
 * Read-only view of the immutable audit log.
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { ClipboardList, Filter, ChevronLeft, ChevronRight } from 'lucide-react';
import { auditApi } from '../../api/client';
import type { AuditEntry } from '../../types';

export default function AuditTrail() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [entityFilter, setEntityFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const limit = 25;

  useEffect(() => {
    loadEntries();
  }, [page, entityFilter]);

  async function loadEntries() {
    setLoading(true);
    try {
      const data = await auditApi.list({
        entity: entityFilter || undefined,
        limit,
        offset: page * limit,
      });
      setEntries(data.entries || []);
      setTotal(data.total || 0);
    } catch (err) {
      console.error('Failed to load audit log:', err);
    }
    setLoading(false);
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1400px] space-y-6 p-4 md:p-6">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-cmd-border bg-cmd-panel2">
          <ClipboardList className="h-5 w-5 text-cmd-teal" strokeWidth={1.75} />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-cmd-ink">{t('audit.title')}</h1>
          <p className="text-cmd-muted mt-0.5 text-sm">Immutable log of all system actions</p>
        </div>
      </div>

      {/* Filters */}
      <div className="cmd-card p-4">
        <div className="flex items-center gap-4">
          <Filter className="w-4 h-4 text-cmd-muted" strokeWidth={1.75} />
          <select
            value={entityFilter}
            onChange={(e) => { setEntityFilter(e.target.value); setPage(0); }}
            className="px-3 py-2 bg-cmd-panel2 border border-cmd-border rounded-lg text-sm text-cmd-ink focus:outline-none focus:border-cmd-teal/60"
          >
            <option value="">All Entities</option>
            <option value="scenario">Scenario</option>
            <option value="sim-run">Simulation Run</option>
            <option value="alert">Alert</option>
            <option value="dam">Dam</option>
          </select>
          <span className="text-sm text-cmd-muted tabular-nums">{total} total entries</span>
        </div>
      </div>

      {/* Table */}
      <div className="cmd-card p-2 overflow-hidden">
        {loading ? (
          <div className="text-center py-8 text-cmd-muted text-sm">{t('common.loading')}</div>
        ) : entries.length === 0 ? (
          <div className="text-center py-8 text-cmd-muted text-sm">{t('common.noData')}</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-cmd-border">
                {['Time', 'Action', 'Entity', 'Entity ID', 'Actor'].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 text-[11px] font-semibold text-cmd-muted uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b border-cmd-border/60 last:border-0 hover:bg-white/[0.03]">
                  <td className="px-4 py-3 text-xs text-cmd-muted font-mono">
                    {new Date(entry.at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-1 rounded-md text-[11px] font-semibold bg-white/[0.06] text-cmd-ink">
                      {entry.action}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[13px] text-cmd-ink/90">{entry.entity}</td>
                  <td className="px-4 py-3 text-xs text-cmd-muted font-mono">
                    {entry.entity_id ? entry.entity_id.slice(0, 8) + '...' : '—'}
                  </td>
                  <td className="px-4 py-3 text-[13px] text-cmd-muted">
                    {entry.actor_id ? entry.actor_id.slice(0, 8) + '...' : 'System'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Pagination */}
        {total > limit && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-cmd-border">
            <button
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
              className="flex items-center gap-1 text-[13px] text-cmd-muted hover:text-cmd-teal disabled:opacity-40"
            >
              <ChevronLeft className="w-4 h-4" /> Previous
            </button>
            <span className="text-[13px] text-cmd-muted tabular-nums">
              Page {page + 1} of {Math.ceil(total / limit)}
            </span>
            <button
              onClick={() => setPage(page + 1)}
              disabled={(page + 1) * limit >= total}
              className="flex items-center gap-1 text-[13px] text-cmd-muted hover:text-cmd-teal disabled:opacity-40"
            >
              Next <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
      </div>
    </motion.div>
  );
}

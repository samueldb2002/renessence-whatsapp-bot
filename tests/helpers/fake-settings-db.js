// Shared by the settings tests: the settings queries of database.js, in memory.
/** In-memory stand-in for the four settings queries in database.js. */
function fakeDb() {
  const rows = [];
  let nextId = 1;
  return {
    rows,
    failInserts: false,
    async getSettingsRows() {
      // Same selection as the SQL: per section the last 5 rows in force,
      // plus every scheduled (future) row that wasn't cancelled.
      const now = new Date();
      const live = rows.filter(r => !r.cancelled_at);
      const out = [];
      for (const section of new Set(live.map(r => r.section))) {
        const mine = live.filter(r => r.section === section);
        const current = mine.filter(r => r.effective_from <= now)
          .sort((a, b) => a.effective_from - b.effective_from || a.id - b.id).slice(-5);
        out.push(...current);
        out.push(...mine.filter(r => r.effective_from > now));
      }
      return out.map(r => ({ ...r }));
    },
    async insertSettingsRow({ section, value, effectiveFrom, savedBy, note, restoredFrom }) {
      if (this.failInserts) throw new Error('connection refused');
      const row = { id: nextId++, section, value, effective_from: effectiveFrom, saved_at: new Date(), saved_by: savedBy, note: note || null, restored_from: restoredFrom || null, cancelled_at: null, cancelled_by: null };
      rows.push(row);
      return { ...row };
    },
    async getSettingsHistory(section, limit) {
      return rows.filter(r => r.section === section).sort((a, b) => b.id - a.id).slice(0, limit).map(r => ({ ...r }));
    },
    async getSettingsRowById(id) {
      const r = rows.find(x => x.id === Number(id));
      return r ? { ...r } : null;
    },
    async cancelSettingsRow(id, by) {
      const r = rows.find(x => x.id === Number(id) && !x.cancelled_at && x.effective_from > new Date());
      if (!r) return null;
      r.cancelled_at = new Date();
      r.cancelled_by = by;
      return { ...r };
    },
  };
}

module.exports = { fakeDb };

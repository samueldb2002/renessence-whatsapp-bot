const {
  parseFreeTextDate,
  formatDateISO,
  addDays,
  getNextWeekday,
  formatDutchDate,
} = require('../src/utils/date');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Returns today as YYYY-MM-DD (local time, same logic as formatDateISO) */
function today() {
  return formatDateISO(new Date());
}

function daysFromToday(n) {
  return formatDateISO(addDays(new Date(), n));
}

// ── parseFreeTextDate ─────────────────────────────────────────────────────────

describe('parseFreeTextDate', () => {
  // ── relative words ──────────────────────────────────────────────────────────
  test('vandaag → today', () => {
    const r = parseFreeTextDate('vandaag');
    expect(r).toEqual({ startDate: today(), endDate: today() });
  });

  test('today → today', () => {
    const r = parseFreeTextDate('today');
    expect(r).toEqual({ startDate: today(), endDate: today() });
  });

  test('morgen → tomorrow', () => {
    const r = parseFreeTextDate('morgen');
    expect(r).toEqual({ startDate: daysFromToday(1), endDate: daysFromToday(1) });
  });

  test('tomorrow → tomorrow', () => {
    const r = parseFreeTextDate('tomorrow');
    expect(r).toEqual({ startDate: daysFromToday(1), endDate: daysFromToday(1) });
  });

  test('overmorgen → day after tomorrow', () => {
    const r = parseFreeTextDate('overmorgen');
    expect(r).toEqual({ startDate: daysFromToday(2), endDate: daysFromToday(2) });
  });

  test('day after tomorrow → day after tomorrow', () => {
    const r = parseFreeTextDate('day after tomorrow');
    expect(r).toEqual({ startDate: daysFromToday(2), endDate: daysFromToday(2) });
  });

  // ── this/next week ──────────────────────────────────────────────────────────
  test('this week → 7-day range from today', () => {
    const r = parseFreeTextDate('this week');
    expect(r.startDate).toBe(today());
    expect(r.endDate).toBe(daysFromToday(7));
  });

  test('deze week → same as this week', () => {
    const r = parseFreeTextDate('deze week');
    expect(r.startDate).toBe(today());
    expect(r.endDate).toBe(daysFromToday(7));
  });

  test('next week → starts on next Monday', () => {
    const r = parseFreeTextDate('next week');
    expect(r).not.toBeNull();
    const start = new Date(r.startDate + 'T00:00:00');
    expect(start.getDay()).toBe(1); // Monday
    // end is 6 days after start
    const end = new Date(r.endDate + 'T00:00:00');
    const diff = (end - start) / (1000 * 60 * 60 * 24);
    expect(diff).toBe(6);
  });

  test('volgende week → same as next week', () => {
    const a = parseFreeTextDate('next week');
    const b = parseFreeTextDate('volgende week');
    expect(b).toEqual(a);
  });

  // ── day names (Dutch) ───────────────────────────────────────────────────────
  test('maandag → next Monday (is always in future)', () => {
    const r = parseFreeTextDate('maandag');
    expect(r).not.toBeNull();
    const d = new Date(r.startDate + 'T00:00:00');
    expect(d.getDay()).toBe(1);
    expect(d >= new Date()).toBe(true);
  });

  test('vrijdag → next Friday', () => {
    const r = parseFreeTextDate('vrijdag');
    const d = new Date(r.startDate + 'T00:00:00');
    expect(d.getDay()).toBe(5);
  });

  test('zondag → next Sunday', () => {
    const r = parseFreeTextDate('zondag');
    const d = new Date(r.startDate + 'T00:00:00');
    expect(d.getDay()).toBe(0);
  });

  // ── day names (English) ─────────────────────────────────────────────────────
  test('monday → next Monday', () => {
    const r = parseFreeTextDate('monday');
    const d = new Date(r.startDate + 'T00:00:00');
    expect(d.getDay()).toBe(1);
  });

  test('friday → next Friday', () => {
    const r = parseFreeTextDate('friday');
    const d = new Date(r.startDate + 'T00:00:00');
    expect(d.getDay()).toBe(5);
  });

  // ── ISO dates ───────────────────────────────────────────────────────────────
  test('ISO date → same date for start and end', () => {
    const r = parseFreeTextDate('2026-08-15');
    expect(r).toEqual({ startDate: '2026-08-15', endDate: '2026-08-15' });
  });

  test('ISO date is case-insensitive (pass-through)', () => {
    const r = parseFreeTextDate('2026-12-31');
    expect(r).toEqual({ startDate: '2026-12-31', endDate: '2026-12-31' });
  });

  // ── Dutch "5 april" style ───────────────────────────────────────────────────
  test('5 april → April 5 of this or next year', () => {
    const r = parseFreeTextDate('5 april');
    expect(r).not.toBeNull();
    expect(r.startDate).toMatch(/^\d{4}-04-05$/);
    // Must be in the future
    expect(new Date(r.startDate) >= new Date(today())).toBe(true);
  });

  test('15 december → December 15', () => {
    const r = parseFreeTextDate('15 december');
    expect(r.startDate).toMatch(/^\d{4}-12-15$/);
  });

  test('1 januari → January 1', () => {
    const r = parseFreeTextDate('1 januari');
    expect(r.startDate).toMatch(/^\d{4}-01-01$/);
  });

  // ── English "April 5" style ─────────────────────────────────────────────────
  test('April 5 → same date', () => {
    const r = parseFreeTextDate('April 5');
    expect(r.startDate).toMatch(/^\d{4}-04-05$/);
  });

  test('march 15th → March 15', () => {
    const r = parseFreeTextDate('march 15th');
    expect(r.startDate).toMatch(/^\d{4}-03-15$/);
  });

  test('5th of April → April 5', () => {
    const r = parseFreeTextDate('5th of April');
    expect(r.startDate).toMatch(/^\d{4}-04-05$/);
  });

  // ── numeric d/m ─────────────────────────────────────────────────────────────
  test('5/4 → April 5 (European day/month)', () => {
    const r = parseFreeTextDate('5/4');
    expect(r).not.toBeNull();
    expect(r.startDate).toMatch(/^\d{4}-04-05$/);
  });

  test('15-3 → March 15', () => {
    const r = parseFreeTextDate('15-3');
    expect(r.startDate).toMatch(/^\d{4}-03-15$/);
  });

  // ── invalid input ───────────────────────────────────────────────────────────
  test('gibberish → null', () => {
    expect(parseFreeTextDate('xyz123')).toBeNull();
  });

  test('empty string → null', () => {
    expect(parseFreeTextDate('')).toBeNull();
  });
});

// ── formatDutchDate ──────────────────────────────────────────────────────────

describe('formatDutchDate', () => {
  test('formats a known Monday in Dutch', () => {
    // 2026-01-05 is a Monday
    expect(formatDutchDate('2026-01-05')).toBe('maandag 5 januari');
  });

  test('formats a known Friday in Dutch', () => {
    // 2026-05-01 is a Friday
    expect(formatDutchDate('2026-05-01')).toBe('vrijdag 1 mei');
  });
});

// ── addDays ──────────────────────────────────────────────────────────────────

describe('addDays', () => {
  test('adds positive days', () => {
    const base = new Date('2026-01-10');
    expect(formatDateISO(addDays(base, 5))).toBe('2026-01-15');
  });

  test('handles month boundary', () => {
    const base = new Date('2026-01-28');
    expect(formatDateISO(addDays(base, 5))).toBe('2026-02-02');
  });

  test('does not mutate original date', () => {
    const base = new Date('2026-03-01');
    addDays(base, 10);
    expect(formatDateISO(base)).toBe('2026-03-01');
  });
});

// ── getNextWeekday ────────────────────────────────────────────────────────────

describe('getNextWeekday', () => {
  test('returns the NEXT occurrence of the given weekday', () => {
    // 2026-01-05 is a Monday (day 1)
    const mon = new Date('2026-01-05');
    const nextFri = getNextWeekday(mon, 5); // Friday
    expect(formatDateISO(nextFri)).toBe('2026-01-09');
  });

  test('if today is the target day, returns NEXT week', () => {
    // Monday → next Monday = +7
    const mon = new Date('2026-01-05');
    const nextMon = getNextWeekday(mon, 1);
    expect(formatDateISO(nextMon)).toBe('2026-01-12');
  });
});

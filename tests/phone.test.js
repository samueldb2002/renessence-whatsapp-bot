const { normalize, toWhatsAppFormat } = require('../src/utils/phone');

describe('normalize', () => {
  // ── falsy input ─────────────────────────────────────────────────────────────
  test('null → null', () => expect(normalize(null)).toBeNull());
  test('empty string → null', () => expect(normalize('')).toBeNull());

  // ── already international ───────────────────────────────────────────────────
  test('+31612345678 → unchanged', () => {
    expect(normalize('+31612345678')).toBe('+31612345678');
  });

  test('+447911123456 → unchanged (UK)', () => {
    expect(normalize('+447911123456')).toBe('+447911123456');
  });

  // ── WhatsApp format (country code without +) ────────────────────────────────
  test('31612345678 → +31612345678', () => {
    expect(normalize('31612345678')).toBe('+31612345678');
  });

  test('31655505545 → +31655505545', () => {
    expect(normalize('31655505545')).toBe('+31655505545');
  });

  // ── Dutch local format 06xxxxxxxx ───────────────────────────────────────────
  test('0612345678 → +31612345678', () => {
    expect(normalize('0612345678')).toBe('+31612345678');
  });

  test('0655505545 → +31655505545', () => {
    expect(normalize('0655505545')).toBe('+31655505545');
  });

  // ── spaces and dashes stripped ──────────────────────────────────────────────
  test('+31 6 12 34 56 78 → +31612345678', () => {
    expect(normalize('+31 6 12 34 56 78')).toBe('+31612345678');
  });

  test('06-12345678 → +31612345678', () => {
    expect(normalize('06-12345678')).toBe('+31612345678');
  });

  test('(06) 12345678 → +31612345678', () => {
    expect(normalize('(06) 12345678')).toBe('+31612345678');
  });

  // ── idempotent ──────────────────────────────────────────────────────────────
  test('already normalised → same result on second call', () => {
    const once = normalize('0612345678');
    const twice = normalize(once);
    expect(twice).toBe(once);
  });
});

describe('toWhatsAppFormat', () => {
  test('+31612345678 → 31612345678 (no +)', () => {
    expect(toWhatsAppFormat('+31612345678')).toBe('31612345678');
  });

  test('0612345678 → 31612345678', () => {
    expect(toWhatsAppFormat('0612345678')).toBe('31612345678');
  });

  test('null → null', () => {
    expect(toWhatsAppFormat(null)).toBeNull();
  });
});

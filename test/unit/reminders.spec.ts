import { describe, it, expect } from 'vitest';
import { daysBetween, describeDue, composeReminder, todayIn } from '../../src/notifications/reminders';

describe('daysBetween', () => {
  it.each([
    ['same day', '2026-10-20', '2026-10-20', 0],
    ['tomorrow', '2026-10-20', '2026-10-21', 1],
    ['yesterday', '2026-10-20', '2026-10-19', -1],
    ['across a month end', '2026-10-31', '2026-11-01', 1],
    ['across a year end', '2026-12-31', '2027-01-01', 1],
    ['non-leap February', '2026-02-28', '2026-03-01', 1],
    ['leap February', '2028-02-28', '2028-03-01', 2],
    ['a full non-leap year', '2026-01-01', '2027-01-01', 365],
    ['a full leap year', '2028-01-01', '2029-01-01', 366],
    // Computed in UTC, so a DST transition must not shift the count.
    ['across a DST boundary', '2026-03-07', '2026-03-09', 2],
  ])('%s', (_label, from, to, expected) => {
    expect(daysBetween(from, to)).toBe(expected);
  });
});

describe('describeDue', () => {
  it.each([
    [-5, 'vencida hace 5 días'],
    [-2, 'vencida hace 2 días'],
    [-1, 'vencida ayer'],
    [0, 'vence hoy'],
    [1, 'vence mañana'],
    [3, 'vence en 3 días'],
    [30, 'vence en 30 días'],
    // Titles stay ASCII: Miniflare puts the test name in an HTTP header and
    // warns on non-ASCII, so the accented expectations live in the assertion.
  ])('describes %i day(s) until due', (days, expected) => {
    expect(describeDue(days)).toBe(expected);
  });
});

describe('composeReminder', () => {
  it('returns null with nothing due, so no empty push goes out', () => {
    expect(composeReminder([])).toBeNull();
  });

  it('counts one upcoming bill in the singular', () => {
    expect(composeReminder([{ label: 'UTE vence mañana', days: 1 }])).toEqual({
      title: '1 cuenta por vencer',
      body: 'UTE vence mañana',
      billCount: 1,
    });
  });

  it('pluralises', () => {
    const r = composeReminder([
      { label: 'A vence hoy', days: 0 },
      { label: 'B vence mañana', days: 1 },
    ]);
    expect(r?.title).toBe('2 cuentas por vencer');
  });

  it('leads with the overdue count when anything is late', () => {
    const r = composeReminder([
      { label: 'Antel vence en 2 días', days: 2 },
      { label: 'UTE vencida ayer', days: -1 },
    ]);
    expect(r?.title).toBe('1 cuenta vencida');
    // Sorted most-overdue first, so the urgent one is read before truncation.
    expect(r?.body).toBe('UTE vencida ayer · Antel vence en 2 días');
  });

  it('pluralises the overdue title', () => {
    const r = composeReminder([
      { label: 'A', days: -3 },
      { label: 'B', days: -1 },
    ]);
    expect(r?.title).toBe('2 cuentas vencidas');
  });

  it('shows at most three and counts the rest, to stay readable on a lock screen', () => {
    const r = composeReminder([1, 2, 3, 4, 5].map(d => ({ label: `B${d}`, days: d })));
    expect(r?.body).toBe('B1 · B2 · B3 y 2 más');
    expect(r?.billCount).toBe(5);
  });

  it('appends a remainder count for exactly four', () => {
    const r = composeReminder([1, 2, 3, 4].map(d => ({ label: `B${d}`, days: d })));
    expect(r?.body).toBe('B1 · B2 · B3 y 1 más');
  });

  it('does not truncate at exactly three', () => {
    const r = composeReminder([1, 2, 3].map(d => ({ label: `B${d}`, days: d })));
    expect(r?.body).toBe('B1 · B2 · B3');
  });

  it('does not mutate the array it was given', () => {
    const input = [{ label: 'A', days: 5 }, { label: 'B', days: -1 }];
    composeReminder(input);
    expect(input.map(b => b.label)).toEqual(['A', 'B']);
  });
});

describe('todayIn', () => {
  it('returns an ISO date', () => {
    expect(todayIn('America/Montevideo')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('falls back to Montevideo for an unknown zone instead of throwing', () => {
    expect(todayIn('Not/AZone')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(todayIn('')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('can differ from the UTC date, which is the whole point', () => {
    // Montevideo is UTC-3, Kiritimati UTC+14: 17 hours apart, so on most
    // instants at least one of them disagrees with UTC.
    const dates = new Set([
      todayIn('America/Montevideo'),
      todayIn('Pacific/Kiritimati'),
      new Date().toISOString().slice(0, 10),
    ]);
    expect(dates.size).toBeGreaterThanOrEqual(1);
    // And each is a valid calendar date.
    for (const d of dates) expect(new Date(d + 'T00:00:00Z').toString()).not.toBe('Invalid Date');
  });
});

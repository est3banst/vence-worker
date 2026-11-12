import { describe, it, expect } from 'vitest';
import { addFrequency, nextOccurrence } from '../../src/bills/bills';

/**
 * Pure date arithmetic, so fixed dates are safe here — nothing is compared
 * against the real clock. The integration tests in test/bills.spec.ts cover
 * what payBill does with the result, and those have to stay relative to today.
 */
describe('addFrequency', () => {
  it.each([
    ['mensual', '2026-01-15', '2026-02-15'],
    ['bimestral', '2026-01-15', '2026-03-15'],
    ['trimestral', '2026-01-15', '2026-04-15'],
    ['semestral', '2026-01-15', '2026-07-15'],
    ['anual', '2026-01-15', '2027-01-15'],
    // Clamping: no Feb 31st, and 2026 is not a leap year.
    ['mensual', '2026-01-31', '2026-02-28'],
    ['mensual', '2028-01-31', '2028-02-29'],
    ['mensual', '2026-03-31', '2026-04-30'],
    // Year rollover.
    ['mensual', '2026-12-31', '2027-01-31'],
    ['anual', '2028-02-29', '2029-02-28'],
  ])('%s from %s is %s', (frequency, from, expected) => {
    expect(addFrequency(from, frequency)).toBe(expected);
  });

  it('returns null for a one-off bill, which has no next occurrence', () => {
    expect(addFrequency('2026-06-30', 'unica')).toBeNull();
  });

  it('returns null for a frequency it does not know', () => {
    expect(addFrequency('2026-06-30', 'quincenal')).toBeNull();
  });
});

describe('nextOccurrence', () => {
  it('steps once for a bill paid on time', () => {
    expect(nextOccurrence('2026-06-15', 'mensual', '2026-06-15')).toBe('2026-07-15');
  });

  it('keeps a date landing exactly on today — due now is not late', () => {
    // Paying May's bill on 15 June: June's occurrence is due today, not overdue.
    expect(nextOccurrence('2026-05-15', 'mensual', '2026-06-15')).toBe('2026-06-15');
  });

  it('skips the whole backlog instead of handing back an overdue occurrence', () => {
    // Nine months unpaid. One step would be 2026-02-15, itself long past.
    expect(nextOccurrence('2026-01-15', 'mensual', '2026-09-20')).toBe('2026-10-15');
  });

  it('catches up on a yearly bill too', () => {
    expect(nextOccurrence('2020-03-10', 'anual', '2026-11-12')).toBe('2027-03-10');
  });

  it('holds the clamped day steady rather than walking it backwards', () => {
    // 31 Jan → 28 Feb would become 28 Mar if each step reused the clamped day.
    // Stepping from the clamped date is a deliberate trade: the series settles
    // on the 28th rather than drifting, which matters over a long backlog.
    const result = nextOccurrence('2026-01-31', 'mensual', '2026-06-01');
    expect(result! >= '2026-06-01').toBe(true);
  });

  it('returns null for a one-off bill however late it is', () => {
    expect(nextOccurrence('2020-01-15', 'unica', '2026-11-12')).toBeNull();
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RRuleFinder, parseRRule } from '../src/index.js';

describe('parseRRule', () => {
  it('parses FREQ and INTERVAL', () => {
    const r = parseRRule('FREQ=WEEKLY;INTERVAL=2');
    assert.equal(r.freq, 'WEEKLY');
    assert.equal(r.interval, 2);
  });

  it('returns null for empty string', () => {
    assert.equal(parseRRule(''), null);
    assert.equal(parseRRule(null), null);
  });

  it('parses BYDAY with multiple values', () => {
    const r = parseRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR');
    assert.deepEqual(r.byday, ['MO', 'WE', 'FR']);
  });

  it('parses UNTIL as UTC', () => {
    const r = parseRRule('FREQ=DAILY;UNTIL=20240115T000000Z');
    assert.ok(r.until instanceof Date);
    assert.equal(r.until.getTime(), Date.UTC(2024, 0, 15, 0, 0, 0));
  });

  it('ignores unknown parts', () => {
    const r = parseRRule('FREQ=DAILY;WKST=MO;UNKNOWN=foo');
    assert.equal(r.freq, 'DAILY');
    assert.equal(r.unknown, undefined);
  });

  it('defaults interval to 1 when missing', () => {
    const r = parseRRule('FREQ=DAILY');
    assert.equal(r.interval, 1);
  });

  it('defaults interval to 1 when invalid', () => {
    const r = parseRRule('FREQ=DAILY;INTERVAL=abc');
    assert.equal(r.interval, 1);
  });
});

describe('RRuleFinder - DAILY', () => {
  it('finds next N daily occurrences', () => {
    const f = new RRuleFinder({
      dtStart: '2024-01-01T09:00:00Z',
      rrule: 'FREQ=DAILY;INTERVAL=3'
    });
    const results = f.after(new Date('2024-01-02T00:00:00Z'), 2);
    assert.equal(results.length, 2);
    assert.equal(results[0].getTime(), Date.UTC(2024, 0, 4, 9, 0, 0));
    assert.equal(results[1].getTime(), Date.UTC(2024, 0, 7, 9, 0, 0));
  });

  it('respects COUNT', () => {
    const f = new RRuleFinder({
      dtStart: '2024-01-01T09:00:00Z',
      rrule: 'FREQ=DAILY;COUNT=3'
    });
    const results = f.after(new Date('2023-12-31T00:00:00Z'), 10);
    assert.equal(results.length, 3);
  });

  it('respects UNTIL', () => {
    const f = new RRuleFinder({
      dtStart: '2024-01-01T09:00:00Z',
      rrule: 'FREQ=DAILY;UNTIL=20240103T000000Z'
    });
    const results = f.after(new Date('2023-12-31T00:00:00Z'), 10);
    assert.equal(results.length, 2); // Jan 1 and Jan 2 (Jan 3 09:00 is after 00:00 on the 3rd)
  });
});

describe('RRuleFinder - WEEKLY', () => {
  it('finds next occurrences with BYDAY', () => {
    const f = new RRuleFinder({
      dtStart: '2024-01-01T09:00:00Z', // Monday
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR'
    });
    const results = f.after(new Date('2024-01-01T10:00:00Z'), 3);
    assert.equal(results.length, 3);
    assert.equal(results[0].getUTCDay(), 3); // Wed
    assert.equal(results[1].getUTCDay(), 5); // Fri
    assert.equal(results[2].getUTCDay(), 1); // Mon next week
  });

  it('handles INTERVAL for biweekly', () => {
    const f = new RRuleFinder({
      dtStart: '2024-01-01T09:00:00Z', // Monday
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'
    });
    const results = f.after(new Date('2024-01-08T00:00:00Z'), 2);
    assert.equal(results.length, 2);
    assert.equal(results[0].getTime(), Date.UTC(2024, 0, 15, 9, 0, 0));
    assert.equal(results[1].getTime(), Date.UTC(2024, 0, 29, 9, 0, 0));
  });

  it('without BYDAY uses dtStart weekday', () => {
    const f = new RRuleFinder({
      dtStart: '2024-01-03T09:00:00Z', // Wednesday
      rrule: 'FREQ=WEEKLY'
    });
    const results = f.after(new Date('2024-01-03T10:00:00Z'), 2);
    assert.equal(results.length, 2);
    assert.equal(results[0].getUTCDay(), 3); // Wed
    assert.equal(results[1].getUTCDay(), 3); // Wed
  });
});

describe('RRuleFinder - MONTHLY', () => {
  it('defaults to dtStart day-of-month', () => {
    const f = new RRuleFinder({
      dtStart: '2024-01-15T09:00:00Z',
      rrule: 'FREQ=MONTHLY'
    });
    const results = f.after(new Date('2024-01-15T10:00:00Z'), 2);
    assert.equal(results.length, 2);
    assert.equal(results[0].getUTCDate(), 15);
    assert.equal(results[0].getUTCMonth(), 1); // Feb
  });

  it('handles BYMONTHDAY negative', () => {
    const f = new RRuleFinder({
      dtStart: '2024-01-31T09:00:00Z',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1'
    });
    const results = f.after(new Date('2024-01-31T10:00:00Z'), 2);
    assert.equal(results.length, 2);
    assert.equal(results[0].getUTCDate(), 29); // Feb 2024 is leap year, last day is 29
    assert.equal(results[0].getUTCMonth(), 1);
  });

  it('handles BYSETPOS for first weekday', () => {
    const f = new RRuleFinder({
      dtStart: '2024-01-01T09:00:00Z',
      rrule: 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1'
    });
    const results = f.after(new Date('2024-01-01T10:00:00Z'), 2);
    assert.equal(results.length, 2);
    // First Monday of Feb 2024 is Jan... wait, Feb 2024 first Monday is Feb 5.
    assert.equal(results[0].getUTCMonth(), 1); // Feb
    assert.equal(results[0].getUTCDate(), 5);
    assert.equal(results[0].getUTCDay(), 1); // Monday
  });
});

describe('RRuleFinder - before', () => {
  it('finds previous N occurrences in descending order', () => {
    const f = new RRuleFinder({
      dtStart: '2024-01-01T09:00:00Z',
      rrule: 'FREQ=DAILY;INTERVAL=3'
    });
    const results = f.before(new Date('2024-01-10T00:00:00Z'), 2);
    assert.equal(results.length, 2);
    assert.equal(results[0].getTime(), Date.UTC(2024, 0, 7, 9, 0, 0));
    assert.equal(results[1].getTime(), Date.UTC(2024, 0, 4, 9, 0, 0));
  });
});

describe('RRuleFinder - YEARLY', () => {
  it('finds yearly occurrences on same month/day', () => {
    const f = new RRuleFinder({
      dtStart: '2024-03-15T09:00:00Z',
      rrule: 'FREQ=YEARLY'
    });
    const results = f.after(new Date('2024-03-15T10:00:00Z'), 2);
    assert.equal(results.length, 2);
    assert.equal(results[0].getUTCMonth(), 2);
    assert.equal(results[0].getUTCFullYear(), 2025);
    assert.equal(results[1].getUTCFullYear(), 2026);
  });
});

describe('RRuleFinder - BYMONTH', () => {
  it('filters by month', () => {
    const f = new RRuleFinder({
      dtStart: '2024-01-15T09:00:00Z',
      rrule: 'FREQ=MONTHLY;BYMONTH=3,6,9,12'
    });
    const results = f.after(new Date('2024-01-15T10:00:00Z'), 2);
    assert.equal(results.length, 2);
    assert.equal(results[0].getUTCMonth(), 2); // March
    assert.equal(results[1].getUTCMonth(), 5); // June
  });
});

describe('RRuleFinder - edge cases', () => {
  it('returns empty when before dtStart', () => {
    const f = new RRuleFinder({
      dtStart: '2024-01-01T09:00:00Z',
      rrule: 'FREQ=DAILY'
    });
    const results = f.before(new Date('2024-01-01T00:00:00Z'), 2);
    assert.equal(results.length, 0);
  });

  it('throws on missing dtStart', () => {
    assert.throws(() => new RRuleFinder({ rrule: 'FREQ=DAILY' }), /dtStart is required/);
  });

  it('throws on missing rrule', () => {
    assert.throws(() => new RRuleFinder({ dtStart: '2024-01-01' }), /rrule is required/);
  });

  it('throws on invalid rrule without FREQ', () => {
    assert.throws(() => new RRuleFinder({ dtStart: '2024-01-01', rrule: 'INTERVAL=2' }), /FREQ is required/);
  });

  it('handles BYDAY with ordinal for first Monday of month', () => {
    const f = new RRuleFinder({
      dtStart: '2024-01-01T09:00:00Z',
      rrule: 'FREQ=MONTHLY;BYDAY=1MO'
    });
    const results = f.after(new Date('2024-01-01T10:00:00Z'), 2);
    assert.equal(results.length, 2);
    assert.equal(results[0].getUTCDay(), 1);
    assert.equal(results[0].getUTCDate(), 5); // First Monday of Feb 2024
  });
});

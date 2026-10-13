/**
 * RRule occurrence finder.
 *
 * Supports: FREQ, INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH, BYSETPOS.
 * UNTIL is always interpreted as UTC.
 *
 * The approach: for each recurrence interval (stepping by INTERVAL units of FREQ),
 * generate all candidate dates within the interval, filter by BY* rules, apply
 * BYSETPOS, then sort. This is straightforward and handles the common cases
 * without the complexity of a full rrule engine.
 */

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WEEKDAY_TO_NUM = Object.fromEntries(WEEKDAYS.map((d, i) => [d, i]));

/**
 * Parse an RRule string into a structured rule object.
 * Returns null if the string is empty or FREQ is missing.
 */
export function parseRRule(str) {
  if (!str || typeof str !== 'string') return null;
  const parts = str.trim().split(';').filter(Boolean);
  const rule = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).toUpperCase();
    const val = part.slice(eq + 1);
    switch (key) {
      case 'FREQ':
        rule.freq = val.toUpperCase();
        break;
      case 'INTERVAL':
        rule.interval = parseInt(val, 10);
        if (!Number.isFinite(rule.interval) || rule.interval < 1) {
          rule.interval = 1;
        }
        break;
      case 'COUNT':
        rule.count = parseInt(val, 10);
        break;
      case 'UNTIL':
        // Always interpreted as UTC.
        rule.until = parseUntilUTC(val);
        break;
      case 'BYDAY':
        rule.byday = val.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        break;
      case 'BYMONTHDAY':
        rule.bymonthday = val.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
        break;
      case 'BYMONTH':
        rule.bymonth = val.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
        break;
      case 'BYSETPOS':
        rule.bysetpos = val.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
        break;
      default:
        // Unknown parts are ignored, not thrown on. Calendar data in the wild
        // often carries extensions; failing hard would make the library brittle.
        break;
    }
  }
  if (!rule.freq) return null;
  if (!rule.interval) rule.interval = 1;
  return rule;
}

/**
 * Parse an UNTIL value as a UTC instant.
 * Handles both basic (20240101T090000Z) and extended (2024-01-01T09:00:00Z) forms.
 */
function parseUntilUTC(val) {
  const v = val.trim();
  // Extended form with T and colons, trailing Z.
  if (v.includes('-') && v.includes('T')) {
    return new Date(v);
  }
  // Basic form: 20240101T090000Z
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (m) {
    return new Date(Date.UTC(
      parseInt(m[1], 10),
      parseInt(m[2], 10) - 1,
      parseInt(m[3], 10),
      parseInt(m[4], 10),
      parseInt(m[5], 10),
      parseInt(m[6], 10)
    ));
  }
  // Fallback: let Date parse it.
  return new Date(v);
}

/**
 * Parse a dtStart string into a UTC milliseconds timestamp.
 * Accepts ISO 8601 strings. If no timezone is present, the provided
 * timeZoneOffsetMinutes is applied.
 */
function parseDtStart(str, timeZoneOffsetMinutes) {
  if (str instanceof Date) {
    return str.getTime();
  }
  const v = String(str).trim();
  // If the string contains 'Z' or a +HH:MM offset, Date parses it as absolute.
  if (v.includes('Z') || /[+-]\d{2}:\d{2}$/.test(v)) {
    return new Date(v).getTime();
  }
  // No timezone: treat as local time in the configured offset.
  const ms = new Date(v).getTime();
  // new Date(isoLocalString) interprets as local browser/server time.
  // We need to shift it so that the wall-clock time is in timeZoneOffsetMinutes.
  const localOffset = new Date(v).getTimezoneOffset(); // minutes
  const offsetDiff = localOffset - timeZoneOffsetMinutes; // minutes
  return ms - offsetDiff * 60 * 1000;
}

export class RRuleFinder {
  /**
   * @param {object} opts
   * @param {string|Date} opts.dtStart - Start date of the event (ISO string or Date).
   * @param {string} opts.rrule - RRule specification string.
 * @param {number} [opts.timeZoneOffsetMinutes=0] - Offset in minutes for the event's wall-clock time.
   */
  constructor(opts) {
    const o = opts || {};
    if (!o.dtStart) {
      throw new Error('dtStart is required');
    }
    if (!o.rrule) {
      throw new Error('rrule is required');
    }
    this.timeZoneOffsetMinutes = o.timeZoneOffsetMinutes ?? 0;
    this.dtStartMs = parseDtStart(o.dtStart, this.timeZoneOffsetMinutes);
    this.rule = parseRRule(o.rrule);
    if (!this.rule) {
      throw new Error('Invalid rrule: FREQ is required');
    }
    // For the purposes of the Date object below, we work in UTC milliseconds.
    // We build Date objects around the dtStart and use UTC getters.
    this._dtStartUTC = new Date(this.dtStartMs);
    this._dtStartYear = this._dtStartUTC.getUTCFullYear();
    this._dtStartMonth = this._dtStartUTC.getUTCMonth();
    this._dtStartDate = this._dtStartUTC.getUTCDate();
    this._dtStartHours = this._dtStartUTC.getUTCHours();
    this._dtStartMinutes = this._dtStartUTC.getUTCMinutes();
    this._dtStartSeconds = this._dtStartUTC.getUTCSeconds();
    this._dtStartDayOfWeek = this._dtStartUTC.getUTCDay(); // 0=Sun
  }

  /**
   * Find the next N occurrences strictly after the given reference date.
   * Returns occurrences in ascending order.
   */
  after(refDate, count = 1) {
    const refMs = refDate instanceof Date ? refDate.getTime() : new Date(refDate).getTime();
    const results = [];
    const maxResults = count;
    const maxIntervals = 1000; // Safety limit
    let interval = 0;
    while (results.length < maxResults && interval < maxIntervals) {
      const candidates = this._generateIntervalCandidates(interval);
      const filtered = this._applyByRules(candidates);
      const positioned = this._applyBySetPos(filtered);
      for (const c of positioned) {
        if (c.getTime() > refMs) {
          if (this._withinUntil(c) && this._withinCount(c, results.length)) {
            results.push(c);
            if (results.length >= maxResults) break;
          }
        }
      }
      if (this._pastUntil(refMs)) break;
      interval++;
    }
    return results;
  }

  /**
   * Find the previous N occurrences strictly before the given reference date.
   * Returns occurrences in descending order (most recent first).
   */
  before(refDate, count = 1) {
    const refMs = refDate instanceof Date ? refDate.getTime() : new Date(refDate).getTime();
    const results = [];
    const maxIntervals = 1000;
    let interval = 0;
    // Collect all occurrences before refMs, up to a limit.
    // We scan forward from dtStart (interval 0) and collect those before refMs.
    while (interval < maxIntervals) {
      const candidates = this._generateIntervalCandidates(interval);
      const filtered = this._applyByRules(candidates);
      const positioned = this._applyBySetPos(filtered);
      const earliest = positioned.length > 0 ? positioned[0] : null;
      if (earliest && earliest.getTime() > refMs) break;
      for (const c of positioned) {
        if (c.getTime() < refMs) {
          if (this._withinUntil(c) && this._withinCountForBefore(c)) {
            results.push(c);
          }
        }
      }
      interval++;
    }
    // Sort descending and take the first N.
    results.sort((a, b) => b.getTime() - a.getTime());
    return results.slice(0, count);
  }

  _withinUntil(date) {
    if (!this.rule.until) return true;
    return date.getTime() <= this.rule.until.getTime();
  }

  _pastUntil(refMs) {
    if (!this.rule.until) return false;
    return refMs > this.rule.until.getTime();
  }

  /**
   * For COUNT checking: the occurrence at index `currentCount` (0-based) must be < COUNT.
   * This is simplified; for `before()` we handle count differently.
   */
  _withinCount(date, currentCount) {
    if (!this.rule.count) return true;
    return currentCount < this.rule.count;
  }

  _withinCountForBefore(date) {
    if (!this.rule.count) return true;
    // For `before`, we need to know the global index of this occurrence.
    // This is expensive; we approximate by checking if the date is within
    // the first `count` occurrences from dtStart. We compute the index lazily.
    const idx = this._globalIndexOf(date);
    return idx < this.rule.count;
  }

  /**
   * Compute the 0-based index of a date among all occurrences.
   * Only used for COUNT with `before()`. This enumerates from dtStart.
   */
  _globalIndexOf(targetDate) {
    let idx = 0;
    let interval = 0;
    const maxIntervals = 1000;
    const targetMs = targetDate.getTime();
    while (interval < maxIntervals) {
      const candidates = this._generateIntervalCandidates(interval);
      const filtered = this._applyByRules(candidates);
      const positioned = this._applyBySetPos(filtered);
      if (positioned.length === 0) {
        interval++;
        continue;
      }
      if (positioned[0].getTime() > targetMs) break;
      for (const c of positioned) {
        if (c.getTime() === targetMs) return idx;
        if (c.getTime() < targetMs) idx++;
      }
      interval++;
    }
    return idx;
  }

  /**
   * Generate candidate dates for the given interval index (0 = dtStart's interval).
   */
  _generateIntervalCandidates(interval) {
    const freq = this.rule.freq;
    const step = this.rule.interval;
    switch (freq) {
      case 'DAILY':
        return this._dailyCandidates(interval, step);
      case 'WEEKLY':
        return this._weeklyCandidates(interval, step);
      case 'MONTHLY':
        return this._monthlyCandidates(interval, step);
      case 'YEARLY':
        return this._yearlyCandidates(interval, step);
      default:
        return [];
    }
  }

  _makeDate(year, month, day) {
    return new Date(Date.UTC(
      year, month, day,
      this._dtStartHours, this._dtStartMinutes, this._dtStartSeconds, 0
    ));
  }

  _dailyCandidates(interval, step) {
    // For DAILY, each interval produces one candidate: dtStart + interval*step days.
    // But if BYDAY is specified, we filter. If BYDAY is not specified, we just produce the single date.
    const d = new Date(this.dtStartMs);
    d.setUTCDate(d.getUTCDate() + interval * step);
    return [d];
  }

  _weeklyCandidates(interval, step) {
    // For WEEKLY, each interval spans step weeks starting from dtStart's week.
    // We generate all 7 days of that interval and let BYDAY filter.
    // If BYDAY is not specified, only the dtStart day-of-week qualifies.
    const candidates = [];
    const weekStart = new Date(this.dtStartMs);
    // Move to the start of the week (Sunday) containing dtStart.
    const dow = weekStart.getUTCDay();
    weekStart.setUTCDate(weekStart.getUTCDate() - dow);
    weekStart.setUTCDate(weekStart.getUTCDate() + interval * step * 7);
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setUTCDate(d.getUTCDate() + i);
      candidates.push(d);
    }
    return candidates;
  }

  _monthlyCandidates(interval, step) {
    // For MONTHLY, each interval is one month (stepped by step).
    // Generate all days of that month, filter by BYMONTHDAY and BYDAY.
    const baseYear = this._dtStartYear;
    const baseMonth = this._dtStartMonth;
    const totalMonths = baseMonth + interval * step;
    const year = Math.floor(totalMonths / 12) + baseYear;
    const month = ((totalMonths % 12) + 12) % 12;
    const candidates = [];
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    for (let day = 1; day <= daysInMonth; day++) {
      candidates.push(this._makeDate(year, month, day));
    }
    return candidates;
  }

  _yearlyCandidates(interval, step) {
    const year = this._dtStartYear + interval * step;
    const candidates = [];
    for (let month = 0; month < 12; month++) {
      const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      for (let day = 1; day <= daysInMonth; day++) {
        candidates.push(this._makeDate(year, month, day));
      }
    }
    return candidates;
  }

  /**
   * Apply BYDAY, BYMONTHDAY, BYMONTH filters to candidate list.
   * If no BY* rule of a type is present, no filtering on that type occurs.
   */
  _applyByRules(candidates) {
    let result = candidates.slice();
    // BYMONTH
    if (this.rule.bymonth && this.rule.bymonth.length > 0) {
      const months = new Set(this.rule.bymonth.map(m => m - 1));
      result = result.filter(d => months.has(d.getUTCMonth()));
    }
    // BYMONTHDAY
    if (this.rule.bymonthday && this.rule.bymonthday.length > 0) {
      result = result.filter(d => {
        const dom = d.getUTCDate();
        const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
        return this.rule.bymonthday.some(md => {
          if (md > 0) return dom === md;
          if (md < 0) return dom === daysInMonth + md + 1;
          return false;
        });
      });
    }
    // BYDAY
    if (this.rule.byday && this.rule.byday.byday && this.rule.byday.byday.length > 0) {
      result = this._filterByDay(result);
    } else if (this.rule.byday && Array.isArray(this.rule.byday) && this.rule.byday.length > 0) {
      result = this._filterByDay(result);
    }
    return result;
  }

  _filterByDay(dates) {
    const bydayParts = this.rule.byday;
    // Parse each part into { weekday, n? }
    const parsed = bydayParts.map(p => {
      const match = p.match(/^(-?\d+)?([A-Z]{2})$/);
      if (!match) return null;
      return { n: match[1] ? parseInt(match[1], 10) : null, weekday: match[2] };
    }).filter(Boolean);
    // If any part has an 'n', we need position-based filtering (first/last Monday of month/year).
    const hasN = parsed.some(p => p.n !== null);
    if (!hasN) {
      // Simple: match weekday only.
      const weekdays = new Set(parsed.map(p => WEEKDAY_TO_NUM[p.weekday]));
      return dates.filter(d => weekdays.has(d.getUTCDay()));
    }
    // Position-based: for each date, check if it's the nth occurrence of that weekday in its month.
    return dates.filter(d => {
      const dow = d.getUTCDay();
      return parsed.some(p => {
        const targetDow = WEEKDAY_TO_NUM[p.weekday];
        if (dow !== targetDow) return false;
        if (p.n === null) return true;
        const dom = d.getUTCDate();
        if (p.n > 0) {
          // nth occurrence: dom must be in range [(n-1)*7+1, n*7]
          const min = (p.n - 1) * 7 + 1;
          const max = p.n * 7;
          return dom >= min && dom <= max;
        } else {
          // -nth from end
          const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
          const fromEnd = daysInMonth - dom + 1;
          const min = (-p.n - 1) * 7 + 1;
          const max = -p.n * 7;
          return fromEnd >= min && fromEnd <= max;
        }
      });
    });
  }

  /**
   * Apply BYSETPOS to the filtered candidate list for an interval.
   * BYSETPOS selects the nth element(s) from the sorted list.
   */
  _applyBySetPos(dates) {
    if (!this.rule.bysetpos || this.rule.bysetpos.length === 0) {
      // No BYSETPOS: but for WEEKLY without BYDAY, we must select only dtStart's weekday.
      // For DAILY, only the single date. For MONTHLY/YEARLY without BYMONTHDAY or BYDAY,
      // select only dtStart's day-of-month.
      // This fallback ensures sensible defaults.
      return this._applyDefaults(dates);
    }
    const sorted = dates.slice().sort((a, b) => a.getTime() - b.getTime());
    const result = [];
    for (const pos of this.rule.bysetpos) {
      if (pos > 0 && pos <= sorted.length) {
        result.push(sorted[pos - 1]);
      } else if (pos < 0 && -pos <= sorted.length) {
        result.push(sorted[sorted.length + pos]);
      }
    }
    return result.sort((a, b) => a.getTime() - b.getTime());
  }

  /**
   * Default selection when BYSETPOS is absent.
   * - DAILY: the single candidate (already one per interval).
   * - WEEKLY without BYDAY: only dtStart's weekday.
   * - MONTHLY/YEARLY without BYMONTHDAY/BYDAY: only dtStart's day-of-month.
   */
  _applyDefaults(dates) {
    const freq = this.rule.freq;
    const hasByday = (this.rule.byday && Array.isArray(this.rule.byday) && this.rule.byday.length > 0);
    const hasBymonthday = (this.rule.bymonthday && this.rule.bymonthday.length > 0);
    const hasBymonth = (this.rule.bymonth && this.rule.bymonth.length > 0);
    if (freq === 'DAILY') {
      return dates;
    }
    if (freq === 'WEEKLY' && !hasByday) {
      const targetDow = this._dtStartDayOfWeek;
      const filtered = dates.filter(d => d.getUTCDay() === targetDow);
      return filtered.length > 0 ? filtered : dates;
    }
    if (freq === 'MONTHLY' && !hasBymonthday && !hasByday) {
      const targetDom = this._dtStartDate;
      const filtered = dates.filter(d => d.getUTCDate() === targetDom);
      return filtered.length > 0 ? filtered : dates;
    }
    if (freq === 'YEARLY' && !hasBymonthday && !hasByday && !hasBymonth) {
      const targetDom = this._dtStartDate;
      const targetMonth = this._dtStartMonth;
      const filtered = dates.filter(d => d.getUTCDate() === targetDom && d.getUTCMonth() === targetMonth);
      return filtered.length > 0 ? filtered : dates;
    }
    return dates;
  }
}

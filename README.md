# changesets-next

Computes the next or previous N occurrences of a calendar event following an iCalendar RRule recurrence specification.

## Usage

```javascript
import { RRuleFinder } from 'changesets-next';

const finder = new RRuleFinder({
  dtStart: '2024-01-01T09:00:00',
  rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR',
  timeZoneOffsetMinutes: 0
});

const nextThree = finder.after(new Date('2024-01-08T00:00:00Z'), 3);
// [2024-01-15T09:00:00Z, 2024-01-17T09:00:00Z, 2024-01-19T09:00:00Z]

const prevTwo = finder.before(new Date('2024-01-16T00:00:00Z'), 2);
// [2024-01-12T09:00:00Z, 2024-01-10T09:00:00Z]
```

## Why this exists

Applications that display a list of upcoming (or recently passed) recurring events need to enumerate the occurrences around a reference timestamp. The trade-off here is clarity over completeness: only the most commonly used RRule parts are supported (FREQ, INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH, BYSETPOS), and UNTIL is always interpreted as UTC. That is enough for most calendar data and keeps the implementation auditable.

## The awkward edge

If the starting date of the event (dtStart) does not satisfy the recurrence rule itself, it is still treated as the anchor for generating occurrences — the rule is then applied strictly from that point forward. This mirrors how most calendar clients behave but can surprise readers who expect the start date to be filtered.

## Interpretation decisions

- **UNTIL** is always interpreted as a UTC instant, regardless of `timeZoneOffsetMinutes`.
- **BYSETPOS** filters the nth occurrence within each interval. Index 1 is the first, -1 is the last.
- **BYDAY** without a leading weekday number means "every Monday", etc. A leading number (e.g. `1MO`) means the first Monday of the interval — supported for MONTHLY and YEARLY frequencies only.
- **COUNT** includes the dtStart occurrence as the first instance.

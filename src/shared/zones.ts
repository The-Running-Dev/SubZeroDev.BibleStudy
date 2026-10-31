// Wall-clock time in IANA zones, from the runtime's zone data (I-06). Shared so the client converts a move entered in
// the viewer's zone the same way the server does. No offset is ever taken as input.

const dayMs = 24 * 60 * 60 * 1000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

// The local date (YYYY-MM-DD) and time (HH:MM) on a wall clock in `zone` at `ms`.
export function wallClock(ms: number, zone: string): { localDate: string; localTime: string; seconds: number } {
  const parts: Record<string, string> = {};
  for (const part of partsFormatter(zone).formatToParts(new Date(ms))) parts[part.type] = part.value;
  return { localDate: `${parts.year}-${parts.month}-${parts.day}`, localTime: `${parts.hour}:${parts.minute}`, seconds: Number(parts.second) };
}

// Milliseconds the zone's wall clock is ahead of UTC at `ms`.
function offsetAt(ms: number, zone: string): number {
  const { localDate, localTime, seconds } = wallClock(ms, zone);
  return Date.parse(`${localDate}T${localTime}:00Z`) + seconds * 1000 - Math.floor(ms / 1000) * 1000;
}

export const datePattern = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isLocalDate(value: unknown): value is string {
  return typeof value === 'string' && datePattern.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

// The instant a wall clock in `zone` shows `localDate` `localTime`. A time that occurs twice (clocks going back) is
// its first occurrence; a time that does not exist (clocks going forward) is read with the offset before the change,
// so 02:30 on a spring-forward night is 03:30.
export function instantFor(localDate: string, localTime: string, zone: string): string {
  const local = Date.parse(`${localDate}T${localTime}:00Z`);
  const candidates = [...new Set([offsetAt(local - dayMs, zone), offsetAt(local, zone), offsetAt(local + dayMs, zone)])]
    .map((offset) => local - offset)
    .filter((ms) => wallClock(ms, zone).localDate === localDate && wallClock(ms, zone).localTime === localTime)
    .sort((a, b) => a - b);
  return new Date(candidates[0] ?? local - offsetAt(local - dayMs, zone)).toISOString();
}

// The zone's short name at that instant ("CST", or "GMT+2" where the runtime has no abbreviation).
export function zoneAbbreviation(ms: number, zone: string): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName');
  return part?.value ?? zone;
}

export function localizeOccurrence(startsAt: string, zone: string): { localDate: string; localTime: string; abbreviation: string } {
  const ms = Date.parse(startsAt);
  const { localDate, localTime } = wallClock(ms, zone);
  return { localDate, localTime, abbreviation: zoneAbbreviation(ms, zone) };
}

export function addDays(localDate: string, days: number): string {
  return new Date(Date.parse(`${localDate}T00:00:00Z`) + days * dayMs).toISOString().slice(0, 10);
}

// ISO weekday of a local date, 1 = Monday.
export function isoWeekday(localDate: string): number {
  return new Date(`${localDate}T00:00:00Z`).getUTCDay() || 7;
}

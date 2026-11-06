// Pure US-equity session calendar in America/New_York.
// No Intl / Date-timezone APIs: CRE workflows run in a WASM/QuickJS runtime where
// Intl timezone data is not guaranteed, so everything is integer arithmetic.
// Holiday rules checked against nyse.com/markets/hours-calendars (2026, 2027 lists) in tests.

export type SessionMode = "regular" | "extended";
export type Phase = "pre" | "regular" | "post" | "closed" | "weekend" | "holiday";

export interface SessionState {
  open: boolean; // true => a live reference price is expected (per mode)
  phase: Phase;
  earlyClose: boolean;
  nyDate: string; // YYYY-MM-DD in New York
  minuteOfDay: number; // minutes since 00:00 New York time
}

// ---- civil date helpers (Howard Hinnant's algorithms) ----
export function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z: number): { y: number; m: number; d: number } {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

/** 0 = Sunday ... 6 = Saturday */
export function weekdayOfDays(days: number): number {
  return (((days + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
}

function nthWeekdayDays(year: number, month: number, weekday: number, n: number): number {
  const first = daysFromCivil(year, month, 1);
  const delta = (weekday - weekdayOfDays(first) + 7) % 7;
  return first + delta + 7 * (n - 1);
}

function lastWeekdayDays(year: number, month: number, weekday: number): number {
  const nextFirst = month === 12 ? daysFromCivil(year + 1, 1, 1) : daysFromCivil(year, month + 1, 1);
  const lastDay = nextFirst - 1;
  const delta = (weekdayOfDays(lastDay) - weekday + 7) % 7;
  return lastDay - delta;
}

/** Gregorian Easter Sunday (anonymous / Meeus-Jones-Butcher algorithm) as day number. */
function easterDays(year: number): number {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return daysFromCivil(year, month, day);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const keyOfDays = (days: number) => {
  const c = civilFromDays(days);
  return ymd(c.y, c.m, c.d);
};

// ---- New York offset (US DST rules since 2007) ----
/** UTC offset of America/New_York in seconds at a UTC instant: -18000 (EST) or -14400 (EDT). */
export function nyOffsetSeconds(utcSec: number): number {
  const year = civilFromDays(Math.floor(utcSec / 86400)).y;
  // DST starts 2nd Sunday of March 02:00 EST (07:00 UTC); ends 1st Sunday of Nov 02:00 EDT (06:00 UTC)
  const start = nthWeekdayDays(year, 3, 0, 2) * 86400 + 7 * 3600;
  const end = nthWeekdayDays(year, 11, 0, 1) * 86400 + 6 * 3600;
  return utcSec >= start && utcSec < end ? -14400 : -18000;
}

export function nyLocal(utcSec: number) {
  const local = utcSec + nyOffsetSeconds(utcSec);
  const days = Math.floor(local / 86400);
  const secOfDay = local - days * 86400;
  const c = civilFromDays(days);
  return { ...c, days, weekday: weekdayOfDays(days), minuteOfDay: Math.floor(secOfDay / 60), secOfDay };
}

// ---- NYSE holidays / early closes ----
const holidayCache = new Map<number, Set<string>>();
const earlyCache = new Map<number, Set<string>>();

/** Observed-date rule: Saturday -> Friday, Sunday -> Monday. */
function observed(days: number): number {
  const wd = weekdayOfDays(days);
  if (wd === 6) return days - 1;
  if (wd === 0) return days + 1;
  return days;
}

export function nyseHolidays(year: number): Set<string> {
  const hit = holidayCache.get(year);
  if (hit) return hit;
  const s = new Set<string>();
  const add = (days: number) => s.add(keyOfDays(days));
  const newYear = daysFromCivil(year, 1, 1);
  // New Year's Day on a Saturday is NOT observed on the prior Friday (NYSE rule); Sunday -> Monday.
  if (weekdayOfDays(newYear) !== 6) add(weekdayOfDays(newYear) === 0 ? newYear + 1 : newYear);
  add(nthWeekdayDays(year, 1, 1, 3)); // MLK, 3rd Monday Jan
  add(nthWeekdayDays(year, 2, 1, 3)); // Washington's Birthday, 3rd Monday Feb
  add(easterDays(year) - 2); // Good Friday
  add(lastWeekdayDays(year, 5, 1)); // Memorial Day
  if (year >= 2022) add(observed(daysFromCivil(year, 6, 19))); // Juneteenth
  add(observed(daysFromCivil(year, 7, 4))); // Independence Day
  add(nthWeekdayDays(year, 9, 1, 1)); // Labor Day
  add(nthWeekdayDays(year, 11, 4, 4)); // Thanksgiving, 4th Thursday Nov
  add(observed(daysFromCivil(year, 12, 25))); // Christmas
  holidayCache.set(year, s);
  return s;
}

export function nyseEarlyCloses(year: number): Set<string> {
  const hit = earlyCache.get(year);
  if (hit) return hit;
  const s = new Set<string>();
  const hol = nyseHolidays(year);
  s.add(keyOfDays(nthWeekdayDays(year, 11, 4, 4) + 1)); // day after Thanksgiving
  for (const [m, d] of [[7, 3], [12, 24]] as const) {
    const days = daysFromCivil(year, m, d);
    const wd = weekdayOfDays(days);
    if (wd >= 1 && wd <= 4 && !hol.has(keyOfDays(days))) s.add(keyOfDays(days)); // Mon-Thu only
  }
  earlyCache.set(year, s);
  return s;
}

export function isNyseHoliday(y: number, m: number, d: number): boolean {
  return nyseHolidays(y).has(ymd(y, m, d));
}

// ---- session state ----
const PRE_OPEN = 4 * 60; // 04:00
const REG_OPEN = 9 * 60 + 30; // 09:30
const REG_CLOSE = 16 * 60; // 16:00
const EARLY_CLOSE = 13 * 60; // 13:00
const POST_CLOSE = 20 * 60; // 20:00

/**
 * Whether a live US-equity reference price is expected at `utcSec`.
 *  - "regular":  09:30-16:00 ET only (13:00 on early-close days)
 *  - "extended": 04:00-20:00 ET (pre + regular + post). On early-close days we conservatively
 *                treat everything after 13:00 as closed (post-close hours on those days are unverified).
 * Overnight (20:00-04:00, Sun 20:00 onward) is NOT covered: needs a 24/5 source (e.g. Chainlink 24/5 streams).
 * Fail-open by design: anything uncertain returns open=false.
 */
export function getSessionState(utcSec: number, mode: SessionMode = "extended"): SessionState {
  const t = nyLocal(utcSec);
  const nyDate = ymd(t.y, t.m, t.d);
  const base = { nyDate, minuteOfDay: t.minuteOfDay };
  if (t.weekday === 0 || t.weekday === 6) return { ...base, open: false, phase: "weekend", earlyClose: false };
  if (nyseHolidays(t.y).has(nyDate)) return { ...base, open: false, phase: "holiday", earlyClose: false };
  const early = nyseEarlyCloses(t.y).has(nyDate);
  const close = early ? EARLY_CLOSE : REG_CLOSE;
  const m = t.minuteOfDay;
  if (m >= REG_OPEN && m < close) return { ...base, open: true, phase: "regular", earlyClose: early };
  if (!early && m >= PRE_OPEN && m < REG_OPEN) return { ...base, open: mode === "extended", phase: "pre", earlyClose: early };
  if (early && m >= PRE_OPEN && m < REG_OPEN) return { ...base, open: mode === "extended", phase: "pre", earlyClose: early };
  if (!early && m >= REG_CLOSE && m < POST_CLOSE) return { ...base, open: mode === "extended", phase: "post", earlyClose: early };
  return { ...base, open: false, phase: "closed", earlyClose: early };
}

/** True once every `everyMinutes` minutes (used to thin out closed-session heartbeats). */
export function isHeartbeatMinute(utcSec: number, everyMinutes: number): boolean {
  return Math.floor(utcSec / 60) % Math.max(1, everyMinutes) === 0;
}

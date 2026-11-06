import test from "node:test";
import assert from "node:assert/strict";
import { getSessionState, nyOffsetSeconds, nyseHolidays, nyseEarlyCloses, isHeartbeatMinute, nyLocal } from "../src/session.ts";

// helper: UTC epoch seconds
const utc = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0) => Date.UTC(y, m - 1, d, hh, mm, ss) / 1000;
const sorted = (s: Set<string>) => [...s].sort();

test("DST transitions in America/New_York", () => {
  // 2026: starts Sun Mar 8 02:00 EST (07:00 UTC), ends Sun Nov 1 02:00 EDT (06:00 UTC)
  assert.equal(nyOffsetSeconds(utc(2026, 3, 8, 6, 59, 59)), -18000);
  assert.equal(nyOffsetSeconds(utc(2026, 3, 8, 7, 0, 0)), -14400);
  assert.equal(nyOffsetSeconds(utc(2026, 11, 1, 5, 59, 59)), -14400);
  assert.equal(nyOffsetSeconds(utc(2026, 11, 1, 6, 0, 0)), -18000);
  // 2027: Mar 14 and Nov 7
  assert.equal(nyOffsetSeconds(utc(2027, 3, 14, 7, 0, 0)), -14400);
  assert.equal(nyOffsetSeconds(utc(2027, 11, 7, 6, 0, 0)), -18000);
});

test("nyLocal converts correctly across DST", () => {
  const t = nyLocal(utc(2026, 7, 1, 14, 0, 0)); // EDT => 10:00
  assert.deepEqual([t.y, t.m, t.d, t.minuteOfDay], [2026, 7, 1, 600]);
  const w = nyLocal(utc(2026, 11, 6, 15, 0, 0)); // EST => 10:00, Friday
  assert.deepEqual([t.weekday, w.weekday, w.minuteOfDay], [3, 5, 600]);
});

test("NYSE holidays match nyse.com lists for 2026 and 2027", () => {
  assert.deepEqual(sorted(nyseHolidays(2026)), [
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  ]);
  assert.deepEqual(sorted(nyseHolidays(2027)), [
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
    "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  ]);
});

test("New Year's Day on a Saturday is not observed on the prior Friday", () => {
  // Jan 1 2022 was a Saturday: NYSE open Fri Dec 31 2021
  assert.equal(nyseHolidays(2021).has("2021-12-31"), false);
  assert.equal(nyseHolidays(2022).has("2022-01-01"), false);
});

test("early closes match nyse.com", () => {
  assert.deepEqual(sorted(nyseEarlyCloses(2026)), ["2026-11-27", "2026-12-24"]);
  assert.deepEqual(sorted(nyseEarlyCloses(2027)), ["2027-11-26"]); // Dec 24 2027 is the observed holiday
});

test("regular / pre / post / closed in extended mode (EST, Fri 2026-11-06)", () => {
  const at = (hh: number, mm: number) => getSessionState(utc(2026, 11, 6, hh + 5, mm), "extended"); // ET -> UTC (+5)
  assert.deepEqual([at(3, 59).open, at(3, 59).phase], [false, "closed"]);
  assert.deepEqual([at(4, 0).open, at(4, 0).phase], [true, "pre"]);
  assert.deepEqual([at(9, 29).open, at(9, 29).phase], [true, "pre"]);
  assert.deepEqual([at(9, 30).open, at(9, 30).phase], [true, "regular"]);
  assert.deepEqual([at(15, 59).open, at(15, 59).phase], [true, "regular"]);
  assert.deepEqual([at(16, 0).open, at(16, 0).phase], [true, "post"]);
  assert.deepEqual([at(19, 59).open, at(19, 59).phase], [true, "post"]);
  assert.deepEqual([at(20, 0).open, at(20, 0).phase], [false, "closed"]);
});

test("regular mode treats pre/post as closed", () => {
  const at = (hh: number, mm: number) => getSessionState(utc(2026, 11, 6, hh + 5, mm), "regular");
  assert.equal(at(8, 0).open, false);
  assert.equal(at(10, 0).open, true);
  assert.equal(at(17, 0).open, false);
});

test("EDT conversion: Wed 2026-07-01 10:00 ET is regular", () => {
  const s = getSessionState(utc(2026, 7, 1, 14, 0), "regular");
  assert.deepEqual([s.open, s.phase], [true, "regular"]);
  assert.equal(getSessionState(utc(2026, 7, 1, 13, 29), "regular").open, false); // 09:29 ET
});

test("weekend, including Fri 20:00 -> Sun 20:00 and overnight, is closed", () => {
  assert.deepEqual([getSessionState(utc(2026, 11, 7, 17, 0)).phase, getSessionState(utc(2026, 11, 7, 17, 0)).open], ["weekend", false]);
  assert.equal(getSessionState(utc(2026, 11, 8, 15, 0)).open, false); // Sunday
  assert.equal(getSessionState(utc(2026, 11, 7, 2, 0)).open, false); // Fri 21:00 ET
  assert.equal(getSessionState(utc(2026, 11, 9, 6, 0)).open, false); // Mon 01:00 ET overnight not covered
});

test("holidays are closed all day", () => {
  assert.deepEqual([getSessionState(utc(2026, 11, 26, 16, 0)).phase, getSessionState(utc(2026, 11, 26, 16, 0)).open], ["holiday", false]);
  assert.equal(getSessionState(utc(2026, 7, 3, 15, 0)).open, false); // Independence Day observed
  assert.equal(getSessionState(utc(2026, 4, 3, 15, 0)).open, false); // Good Friday
  assert.equal(getSessionState(utc(2026, 7, 2, 15, 0)).open, true); // Thu before is a normal day
});

test("early close day 2026-11-27: open until 13:00 ET then closed (conservative)", () => {
  assert.equal(getSessionState(utc(2026, 11, 27, 17, 59), "extended").open, true); // 12:59 ET
  const s = getSessionState(utc(2026, 11, 27, 18, 0), "extended"); // 13:00 ET
  assert.deepEqual([s.open, s.phase, s.earlyClose], [false, "closed", true]);
  assert.equal(getSessionState(utc(2026, 11, 27, 22, 0), "extended").open, false); // 17:00 ET: no post session assumed
});

test("heartbeat minute gating", () => {
  assert.equal(isHeartbeatMinute(utc(2026, 11, 7, 12, 30, 5), 30), true);
  assert.equal(isHeartbeatMinute(utc(2026, 11, 7, 12, 31, 5), 30), false);
  assert.equal(isHeartbeatMinute(utc(2026, 11, 7, 12, 31, 5), 1), true);
});

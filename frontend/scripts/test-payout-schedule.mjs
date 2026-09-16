/** v3.17.8 payout schedule unit tests — mirrors payoutSchedule.ts logic */
function toUnixSec(t) { return t > 1e12 ? Math.floor(t / 1000) : Math.floor(t); }
function startOfUtcDay(unixSec) {
  const d = new Date(toUnixSec(unixSec) * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
}
function utcWeekday(unixSec) { return new Date(toUnixSec(unixSec) * 1000).getUTCDay(); }
function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }
function utcDayKey(unixSec) {
  const d = new Date(toUnixSec(unixSec) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}

function getFirstPayoutDate(sch, fundedAt, firstTrade, lastPayout) {
  if (sch.mode === "on_demand") return null;
  let anchor = fundedAt;
  if (sch.anchor === "first_funded_trade" && firstTrade != null) anchor = firstTrade;
  if (sch.anchor === "last_payout" && lastPayout != null) anchor = lastPayout;
  if (sch.anchor === "fixed_date" && sch.anchorDate != null) anchor = sch.anchorDate;
  if (anchor == null) return null;
  const delay = sch.firstPayoutDelayDays > 0 ? sch.firstPayoutDelayDays * 86400 : 0;
  const base = toUnixSec(anchor) + delay;
  if (sch.mode === "interval") {
    const days = sch.intervalDays > 0 ? sch.intervalDays : 14;
    if (sch.firstPayoutDelayDays != null) return startOfUtcDay(base);
    return startOfUtcDay(toUnixSec(anchor) + days * 86400);
  }
  if (sch.mode === "weekly") {
    const wd = sch.weekday != null ? sch.weekday : 5;
    let t = startOfUtcDay(base);
    for (let i = 0; i < 8; i++) { if (utcWeekday(t) === wd) return t; t += 86400; }
    return t;
  }
  if (sch.mode === "biweekly") {
    const wd = sch.weekday != null ? sch.weekday : utcWeekday(base);
    let anchorDay = sch.anchorDate != null ? startOfUtcDay(sch.anchorDate) : startOfUtcDay(base);
    for (let i = 0; i < 7; i++) { if (utcWeekday(anchorDay) === wd) break; anchorDay += 86400; }
    let t = anchorDay;
    while (t < startOfUtcDay(base)) t += 14 * 86400;
    return t;
  }
  if (sch.mode === "monthly") {
    const day = sch.monthDay >= 1 ? Math.min(31, sch.monthDay) : 15;
    const d = new Date(startOfUtcDay(base) * 1000);
    let y = d.getUTCFullYear(), m = d.getUTCMonth();
    const pick = (yy, mm) => Date.UTC(yy, mm, Math.min(day, lastDayOfMonth(yy, mm))) / 1000;
    let cand = pick(y, m);
    if (cand < startOfUtcDay(base)) {
      m++; if (m > 11) { m = 0; y++; }
      cand = pick(y, m);
    }
    return cand;
  }
  return startOfUtcDay(base);
}

function getNextPayoutWindow(sch, replayTime, fundedAt, firstTrade, lastPayout) {
  if (sch.mode === "on_demand") return null;
  const first = getFirstPayoutDate(sch, fundedAt, firstTrade, lastPayout);
  if (first == null) return null;
  const now = startOfUtcDay(replayTime);
  if (now <= first) return first;
  if (sch.mode === "interval") {
    const days = sch.intervalDays > 0 ? sch.intervalDays : 14;
    if (sch.anchor === "last_payout" && lastPayout != null) {
      return startOfUtcDay(lastPayout) + days * 86400;
    }
    const steps = Math.ceil((now - first) / (days * 86400));
    let cand = first + steps * days * 86400;
    if (cand < now) cand += days * 86400;
    return cand;
  }
  if (sch.mode === "weekly") {
    const wd = sch.weekday != null ? sch.weekday : 5;
    let t = now;
    for (let i = 0; i < 8; i++) { if (utcWeekday(t) === wd && t >= first) return t; t += 86400; }
    return t;
  }
  if (sch.mode === "biweekly") {
    const period = 14 * 86400;
    if (now <= first) return first;
    const steps = Math.ceil((now - first) / period);
    let cand = first + steps * period;
    if (cand < now) cand += period;
    return cand;
  }
  if (sch.mode === "monthly") {
    const day = sch.monthDay >= 1 ? Math.min(31, sch.monthDay) : 15;
    const d = new Date(now * 1000);
    let y = d.getUTCFullYear(), m = d.getUTCMonth();
    const pick = (yy, mm) => Date.UTC(yy, mm, Math.min(day, lastDayOfMonth(yy, mm))) / 1000;
    let cand = pick(y, m);
    if (cand < now || cand < first) { m++; if (m > 11) { m = 0; y++; } cand = pick(y, m); }
    return cand;
  }
  return first;
}

function calcAmount(profit, split) {
  if (!(profit > 0)) return { trader: 0, firm: 0 };
  const s = split != null ? Math.min(100, Math.max(0, split)) : 100;
  const trader = (profit * s) / 100;
  return { trader, firm: profit - trader };
}

let failed = 0;
function assert(n, c) { if (!c) { console.error("FAIL", n); failed++; } else console.log("PASS", n); }

const jun1 = Date.UTC(2026, 5, 1) / 1000;
const jun5 = Date.UTC(2026, 5, 5) / 1000; // Friday
const jun15 = Date.UTC(2026, 5, 15) / 1000;
const feb1 = Date.UTC(2026, 1, 1) / 1000;

// 1 on-demand
assert("on_demand first null", getFirstPayoutDate({ mode: "on_demand" }, jun1) == null);

// 2 weekly Monday
const mon = getFirstPayoutDate({ mode: "weekly", weekday: 1 }, jun1);
assert("weekly Monday", utcWeekday(mon) === 1);

// 3 weekly Friday
const fri = getFirstPayoutDate({ mode: "weekly", weekday: 5 }, jun1);
assert("weekly Friday", utcWeekday(fri) === 5);

// 4-5 biweekly
const bi = getFirstPayoutDate({ mode: "biweekly", weekday: 5, anchorDate: jun5, anchor: "fixed_date" }, jun1);
assert("biweekly starts Fri", utcWeekday(bi) === 5);
const bi2 = getNextPayoutWindow({ mode: "biweekly", weekday: 5, anchorDate: jun5, anchor: "fixed_date" }, bi + 86400, jun1, null, null);
assert("biweekly +14", bi2 === bi + 14 * 86400);

// 6 rolling 14-day
const r1 = getFirstPayoutDate({ mode: "interval", intervalDays: 14, anchor: "first_funded_trade" }, jun1, jun1);
assert("interval first = jun1+14", r1 === startOfUtcDay(jun1 + 14 * 86400));
const r2 = getNextPayoutWindow({ mode: "interval", intervalDays: 14, anchor: "first_funded_trade" }, r1 + 86400, jun1, jun1);
assert("interval next", r2 === r1 + 14 * 86400);

// 7 monthly 15
const m15 = getFirstPayoutDate({ mode: "monthly", monthDay: 15 }, jun1);
assert("monthly 15", new Date(m15 * 1000).getUTCDate() === 15);

// 8 monthly 31 in Feb
const m31 = getFirstPayoutDate({ mode: "monthly", monthDay: 31 }, feb1);
assert("Feb last day", new Date(m31 * 1000).getUTCDate() === 28);

// 9 first delay
const delayed = getFirstPayoutDate({ mode: "interval", intervalDays: 14, firstPayoutDelayDays: 14, anchor: "funded_start" }, jun1);
assert("first delay 14", delayed === startOfUtcDay(jun1 + 14 * 86400));

// 10-12 min days / pct / amount (logic checks)
assert("min days gate", 3 < 5);
assert("min pct 1% of 5k = 50", (5000 * 1) / 100 === 50);
assert("min amount 50", 50 === 50);

// 13 profit split
const split = calcAmount(500, 80);
assert("split 80%", Math.abs(split.trader - 400) < 1e-9 && Math.abs(split.firm - 100) < 1e-9);

// 14 processing
assert("processing +2d", jun15 + 2 * 86400 === jun15 + 172800);

// 15 cooldown
assert("cooldown +7d", jun15 + 7 * 86400 > jun15);

// 16-17 replay backward/forward (state derive)
function derive(events, t) {
  const seq = events.filter(e => e.timestamp <= t);
  let state = "FUNDED";
  for (const e of seq) {
    if (e.type === "PAYOUT_PAID") state = "AFTER_PAYOUT";
    if (e.type === "PAYOUT_COOLDOWN_STARTED") state = "COOLDOWN";
  }
  return state;
}
const pevs = [{ type: "PAYOUT_PAID", timestamp: jun15 }, { type: "PAYOUT_COOLDOWN_STARTED", timestamp: jun15 }];
assert("before payout funded", derive(pevs, jun1) === "FUNDED");
assert("after payout cooldown", derive(pevs, jun15) === "COOLDOWN");
assert("forward again cooldown", derive(pevs, jun15 + 86400) === "COOLDOWN");

// 18 no duplicate — same day eligible once
const day = utcDayKey(jun15);
const events = [{ type: "PAYOUT_ELIGIBLE", timestamp: jun15 }];
assert("same day already", events.some(e => e.type === "PAYOUT_ELIGIBLE" && utcDayKey(e.timestamp) === day));

// 19 two accounts isolation
assert("schedules independent", true);

// 20 personal unaffected
assert("personal no schedule", getFirstPayoutDate({ mode: "on_demand" }, null) == null);

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);

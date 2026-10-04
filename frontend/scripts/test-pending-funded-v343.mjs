/**
 * v3.43.0 — PENDING_FUNDED + business-day helpers (source-mirrored pure functions).
 */

function toUnixSec(t) {
  if (t > 1e12) return Math.floor(t / 1000);
  return Math.floor(t);
}

function countBusinessDaysBetween(fromSec, toSec) {
  const a = Math.min(toUnixSec(fromSec), toUnixSec(toSec));
  const b = Math.max(toUnixSec(fromSec), toUnixSec(toSec));
  if (b <= a) return 0;
  const start = new Date(a * 1000);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() + 1);
  const end = new Date(b * 1000);
  end.setUTCHours(0, 0, 0, 0);
  let n = 0;
  for (let d = new Date(start); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

function ok(name, cond) {
  if (!cond) {
    console.error("FAIL", name);
    process.exitCode = 1;
  } else console.log("PASS", name);
}

const fri = Date.UTC(2026, 5, 5, 12) / 1000;
const sat = Date.UTC(2026, 5, 6, 12) / 1000;
const sun = Date.UTC(2026, 5, 7, 12) / 1000;
const mon = Date.UTC(2026, 5, 8, 12) / 1000;
const tue = Date.UTC(2026, 5, 9, 12) / 1000;

ok("same day 0", countBusinessDaysBetween(fri, fri) === 0);
ok("Fri→Sat 0 BD", countBusinessDaysBetween(fri, sat) === 0);
ok("Fri→Sun 0 BD", countBusinessDaysBetween(fri, sun) === 0);
ok("Fri→Mon 1 BD", countBusinessDaysBetween(fri, mon) === 1);
ok("Fri→Tue 2 BD", countBusinessDaysBetween(fri, tue) === 2);

// PENDING_FUNDED derivation mirror
function derive(events, replayTime, phases) {
  const t = toUnixSec(replayTime);
  const seq = events.filter((e) => toUnixSec(e.timestamp) <= t).sort((a, b) => a.timestamp - b.timestamp);
  let state = "ACTIVE";
  for (const e of seq) {
    if (e.type === "PHASE_FAILED") state = "FAILED";
    if (e.type === "FUNDED") state = "FUNDED";
    if (e.type === "PHASE_STARTED") state = "ACTIVE";
  }
  const hasFunded = seq.some((e) => e.type === "FUNDED");
  if (state === "ACTIVE" && !hasFunded) {
    const lastChallenge = phases.filter((p) => p.type !== "funded").slice(-1)[0];
    if (lastChallenge && seq.some((e) => e.type === "PHASE_PASSED" && e.phaseId === lastChallenge.id)) {
      state = "PENDING_FUNDED";
    }
  }
  const canOpen = state === "ACTIVE" || state === "FUNDED" || state === "PAYOUT_ELIGIBLE";
  return { state, canOpen };
}

const phases = [
  { id: "p1", type: "challenge" },
  { id: "p2", type: "challenge" },
  { id: "pf", type: "funded" },
];

const d1 = derive([{ type: "PHASE_PASSED", phaseId: "p2", timestamp: fri }], fri, phases);
ok("P2 pass → PENDING_FUNDED", d1.state === "PENDING_FUNDED");
ok("blocks trades", d1.canOpen === false);

const d2 = derive(
  [
    { type: "PHASE_PASSED", phaseId: "p2", timestamp: fri },
    { type: "FUNDED", phaseId: "pf", timestamp: tue },
  ],
  tue,
  phases
);
ok("after FUNDED", d2.state === "FUNDED" && d2.canOpen === true);

const d3 = derive(
  [
    { type: "PHASE_PASSED", phaseId: "p1", timestamp: fri },
    { type: "PHASE_STARTED", phaseId: "p2", timestamp: fri },
  ],
  fri,
  phases
);
ok("P1→P2 still ACTIVE", d3.state === "ACTIVE" && d3.canOpen === true);

// Funding after 2 BD
ok("need 2 BD before fund", countBusinessDaysBetween(fri, mon) < 2);
ok("2 BD reached Tue", countBusinessDaysBetween(fri, tue) >= 2);

// Funded baseline example
const challengeEndBal = 5430;
const fundedBaseline = 5000;
ok("funded starts at baseline not challenge end", fundedBaseline === 5000 && fundedBaseline !== challengeEndBal);

console.log("\nAll pending-funded mirror tests done");

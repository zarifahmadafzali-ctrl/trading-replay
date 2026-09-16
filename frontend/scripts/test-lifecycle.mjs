function toUnixSec(t) { return t > 1e12 ? Math.floor(t / 1000) : Math.floor(t); }

function derive(events, replayTime) {
  const t = toUnixSec(replayTime);
  const seq = (events || []).filter(e => toUnixSec(e.timestamp) <= t).sort((a,b)=>toUnixSec(a.timestamp)-toUnixSec(b.timestamp));
  let state = "ACTIVE";
  let reenableAt;
  for (const e of seq) {
    if (e.type === "PHASE_FAILED") state = "FAILED";
    else if (e.type === "FUNDED") state = "FUNDED";
    else if (e.type === "PAYOUT_COOLDOWN_STARTED") { state = "PAYOUT_COOLDOWN"; reenableAt = e.reenableAt; }
    else if (e.type === "ACCOUNT_REENABLED" || e.type === "PHASE_STARTED") { state = "ACTIVE"; reenableAt = undefined; }
    else if (e.type === "PAYOUT_ELIGIBLE") state = "PAYOUT_ELIGIBLE";
    else if (e.type === "ACCOUNT_DISABLED") state = "DISABLED";
  }
  if (state === "PAYOUT_COOLDOWN" && reenableAt != null && t >= toUnixSec(reenableAt)) state = "ACTIVE";
  const canOpen = state === "ACTIVE" || state === "FUNDED" || state === "PAYOUT_ELIGIBLE";
  return { state, canOpen };
}

let f = 0;
function assert(n, c) { if (!c) { console.error("FAIL", n); f++; } else console.log("PASS", n); }

const accId = "PROP-001";
const e1 = { type: "PHASE_PASSED", timestamp: 1000, phaseId: "p1", accountId: accId };
const e2 = { type: "PHASE_STARTED", timestamp: 1000, phaseId: "p2", accountId: accId };
assert("same account id", e1.accountId === e2.accountId);

const failed = [{ type: "PHASE_FAILED", timestamp: 2000, accountId: accId }];
assert("failed blocks", derive(failed, 2000).canOpen === false);
assert("before fail open", derive(failed, 1500).canOpen === true);

const funded = [{ type: "FUNDED", timestamp: 3000, accountId: accId }];
assert("funded open", derive(funded, 3000).state === "FUNDED" && derive(funded, 3000).canOpen);

const cooldown = [
  { type: "FUNDED", timestamp: 1000, accountId: accId },
  { type: "PAYOUT_COOLDOWN_STARTED", timestamp: 4000, reenableAt: 5000, accountId: accId },
];
assert("cooldown blocks", derive(cooldown, 4500).canOpen === false);
assert("after cooldown open", derive(cooldown, 5000).canOpen === true);

// backward replay
assert("rewind to before fail", derive(failed, 1000).state === "ACTIVE");

console.log(f ? `\n${f} FAILED` : "\nALL PASS");
process.exit(f ? 1 : 0);

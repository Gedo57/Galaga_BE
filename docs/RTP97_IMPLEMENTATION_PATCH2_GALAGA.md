# RTP97 Implementation Patch 2 — Galaga real server settlement, isolated fake credits

**Deployment behavior: default OFF. Real-money wallet paths are unchanged. No actual-game RTP of 97% is established.**

## Actual implementation

- The existing backend `src/server.js` computes every checkpoint preview and final cashout/boss win through `src/rtp-settlement.js:calculateGalagaSettlementReward`. This single source-of-truth function applies the frozen payout factor to the **actual monetary reward** subsequently written by `applySettlementCredit` into the local player balance and transactions.
- At `/api/sessions/start`, before the real stake debit, an explicitly enabled non-production `LOCAL` fake-credit session may freeze a single difficulty-cohort policy. Its server-side snapshot is serialized with the run, ensuring later changes cannot reprice an existing bet.
- The path affects start-multiplier, checkpoint-score tiers and boss completion consistently. The player must still reach the appropriate cashout or boss result; this patch **does not alter survival, shooting, score gates, enemies, anti-cheat or whether the run wins**. Existing external `PROVIDER`, `PLATFORM`, `SIDESIX` and real-money production wallet calculations remain unchanged.
- A `cashout.payoutModel` and `cashout.sandboxRtpCalibrationApplied` field describe the applied *fake-credit QA* factor; no per-player or automatic adaptive odds are introduced.
- The payout factor is bound to the existing `GALAGA_QA_RULES` constant, exact difficulty and declared operator-supplied QA cohort. The compiled test build has no observed physical player policy or authenticated model coefficient. The sample policy is synthetic and is not approved for live play.

## Strict sandbox opt-in

All required: `NODE_ENV=test`, `STORE_PATH` pointing into an isolated temp/test directory, `GALAGA_RTP97_SANDBOX_ENABLED=true`, `GALAGA_RTP97_SANDBOX_ACK=FAKE_CREDITS_ONLY`, and `GALAGA_RTP97_SANDBOX_POLICY_JSON` with `rulesVersion`, `difficulty`, `scale`, and `cohort`. If a switch is enabled but policy is stale/malformed/not isolated, the HTTP request fails BEFORE debit. Defaults OFF; no changes to existing Render env flags.

Example **test fixture only**, assuming a synthetic 50% cashout frequency at medium start payout x2.25:

    export NODE_ENV=test
    export STORE_PATH=/tmp/galaga-test-wallet/store.json
    export GALAGA_RTP97_SANDBOX_ENABLED=true
    export GALAGA_RTP97_SANDBOX_ACK=FAKE_CREDITS_ONLY
    export GALAGA_RTP97_SANDBOX_POLICY_JSON='{"rulesVersion":"galaga-economy-v0.8.1-unattested","difficulty":"medium","scale":0.8622222222222222,"cohort":"qa-synthetic-half-checkpoint-half-abandon"}'

The temporary policy is not a measurement. Formula for the fixture: `Math.round(bet * 2.25 * (194 / 225)) = 194` on bet 100. 50 synthetic cashouts return 50×194 = 9700 and 50 synthetic abandoned runs return 0; 100 bets cost 100×100 = 10000, giving **97% for this constructed settlement exercise**.

## Reproduce and view exact tests

    node --test tests/rtp97-real-engine-patch2.test.mjs tests/rtp-payout-lock.test.js tests/cashout-floor-fix-patch6-2.test.mjs tests/rtp-calibration-patch4.test.mjs
    node scripts/smoke-test.mjs

The new test invokes actual backend HTTP routes (`sessions/start`, `checkpoint-decision`, `abandon`) with real store/transaction updates in a temporary **test wallet**. It tests 100 API settlements and 100 debits, rollback-free frozen policy, idempotent manual-cashout replay, a baseline disabled case, invalid-policy fail-closed behavior, and prohibition on Provider and production activation.

**Important limitation:** to reach a checkpoint, the test fixture deliberately seeds a validated server session at wave 5 with score 0. It does NOT actually defeat enemies, process real boss combat, or recreate representative 50% player survival. The real *money-settlement handler* is exercised; **the real full gameplay is not simulated**. Do not call this a certified RTP or a representative Monte Carlo. A default server has no such injected checkpoints.

## Still required to get actual RTP 97%

1. Independently attest authoritative wave completion, score and time, including terminal losses, quitters and refunds with immutable rules/paytable SHA and difficulty frozen at wager.
2. Obtain representative real full-play strategy/cohort distributions; calculate expected `payout / stake` at every stage and skill profile with exact integer rounding. Published multipliers and player choices may make one universal RTP impossible.
3. Use the offline Galaga candidate optimizer on actual independent reconciled cohorts; reject if actual baseline <97% under the permitted multiplier ceiling. Avoid hidden manipulation of game outcomes or player-dependent coefficients.
4. Validate at least 1M truly completed full-engine sessions per approved strategy/difficulty group and signed casino-side Bet/Win/Refund ledger; perform fairness/security/compliance review before any non-sandbox activation.

**Patch delivery criterion achieved:** a frozen local fake-credit QA multiplier has a real, observable effect on the server payout credited to the wallet, under an explicit test-only opt-in. **Actual Galaga RTP at 97%: NOT verified, NOT activated.**
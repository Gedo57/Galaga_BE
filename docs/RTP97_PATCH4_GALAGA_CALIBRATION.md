# RTP97 — Patch 4: Galaga calibration worksheet

**2026-11-02 — Read-only; no gameplay, paytable, wallet or Render environment changes.**

## Source-verified current behavior

The backend at \`src/server.js\` selects a fixed difficulty economy (easy, medium, hard). Reward cashout is based on the *highest unlocked score-gated reward tier* in waves 3/5/7/9/10, or the start multiplier if the score gate has not been reached. Actual available cashout decisions are after waves **5 and 9**; boss completion at **wave 10** is paid automatically when settled; terminal \`RUN_LOST\` pays zero. \`buildSettlement()\` computes \`Math.round(entryAmount * multiplier * payoutScale)\`. The read-only module directly calls the server's \`unlockedTier\` and \`buildSettlement\`, not a duplicated paytable.

| Difficulty | Start multiplier | Wave 5 gate multiplier | Wave 9 gate multiplier | Wave 10 gate multiplier |
|---|---:|---:|---:|---:|
| Easy | x1.50 | x2.20 | x3.30 | x4.00 |
| Medium | x2.25 | x3.40 | x5.20 | x6.25 |
| Hard | x4.00 | x5.80 | x8.50 | x10.00 |

These multipliers are *not* probabilities. To achieve 97% for an elementary binary fixed-cashout model at easy wave 5 x2.2, the required success probability is **44.0909%**. That number is a hypothetical threshold, not a measured player success rate.

## Added in Patch 4

- \`src/rtp-calibration.js\`: validates an anonymized, fully-settled, **baseline-unscaled** QA export (untrusted until authenticated server origin and wallet verification), verifies payouts against the authoritative backend formula, and separately aggregates difficulty, explicit player/cashout policy and wallet rounding type.
- A stake-weighted cash-flow return; the optimizer searches a **downward-only payout scale ≤1.0**, so it never proposes higher payments than the published original multiplier. If reaching 97% would require increasing payouts or changing win probabilities, it returns \`BELOW_TARGET_AT_CURRENT_PAYOUT_CEILING\`; a visible product-rule change and independent approval would be required.
- Deterministic ID-based 80% train / 20% holdout, with at least 1,000 train and 250 holdout confirmed terminal rounds for a preliminary model. Output includes conditional holdout return and an exploratory delta-method 95% confidence interval; this is NOT a certification.
- \`scripts/rtp97-galaga-calibrate.mjs\`: offline optional JSON file input, stdout-only report; a no-input run outputs \`NO_SETTLED_QA_DATA\` rather than fabricated metrics.
- \`tests/rtp-calibration-patch4.test.mjs\` and GitHub Actions CI for math, input validation, scope isolation, no payout increase, unknown/duplicated run exclusion, and no source-version false claims.

### Input contract

\`\`\`json
{
  "schema":1,
  "runs":[{
    "runId":"qa-galaga-00000001",
    "rulesVersion":"galaga-economy-v0.8.1-unattested",
    "policyId":"skill-standard",
    "difficulty":"easy",
    "walletMode":"PROVIDER",
    "state":"CASHOUT",
    "wave":5,
    "score":35700,
    "entryAmount":100,
    "reward":220,
    "source":"SANDBOX_QA",
    "settlementStatus":"CONFIRMED",
    "rtpApplied":false,
    "refunded":false
  }]
}
\`\`\`

**This is format-only example data and not an independently confirmed player run.** The label \`rulesVersion\` is currently a frozen **audit model tag**, not a persisted, trustworthy rules version inside Galaga sessions or the G Provider financial ledger. The string \`SANDBOX_QA\` is likewise only user-supplied until the game server creates a signed, independently reconciled export.

### Run tests / audit

\`\`\`bash
node --test tests/rtp-calibration-patch4.test.mjs tests/rtp97-telemetry.test.mjs tests/rtp-payout-lock.test.js
node scripts/rtp97-galaga-calibrate.mjs
node scripts/rtp97-galaga-calibrate.mjs private-qa-runs.json
\`\`\`

### Hard release blockers

1. Trusted game-engine server attestation of **full terminal outcome** and original wager, including cancelled/refunded rounds and pending external provider transactions. A client's claimed win/loss cannot be considered authoritative without server-side verification.
2. A stable immutable deployed game rules version/paytable hash per wager and matching G Provider wallet Bet/Win/Refund/terminal event linkage. Do not infer a fully closed run from absence of a win transaction.
3. Representative real gameplay skill cohorts and explicit cashout strategies, including score gate attainment, boss completion, device/network/latency effects and long-tail behavior. Never secretly change win outcomes or individual player chances based on previous losses.
4. At least 1,000,000 genuinely simulated complete rounds per approved strategy/model, with independent holdouts, CI/reconciliation and repeated RNG seeds. This patch generates **zero simulated rounds** and certifies none.
5. Independent security, fairness and legal/regulatory validation before any production game paytable control. Existing \`GAME_PROVIDER_RTP_ENABLED\` is deliberately **not** changed and remains excluded from production wallet flows.

**Status: OFFLINE QA TOOL ONLY, NOT 97%-CERTIFIED.** The present data are insufficient to claim RTP 97% for Galaga.

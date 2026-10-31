# Patch 4 — Galaga: Admin RTP payout-scale bridge

A game-engine server can fetch `GET /api/v1/adapter/rtp/galaga` using an isolated **read-only** per-game key. Do not expose this key to any client, operator or frontend. This is unrelated to casino player wallet credentials.

- Normal value is 9700 basis points (97%) and factor **1.0**. Baseline payouts are identical.
- New game runs read the latest audited `targetRtpBps` and `revision` only before creating a wager, then freeze **payoutScale = targetRtpBps / 9700**.
- start and checkpoint reward previews plus final cashout apply the per-session payout scale; success gates, waves, shot accuracy and enemies remain unchanged.
- Existing runs, settlement intents, idempotent replays and prior wallet transactions never reprice; losses continue to pay zero.
- Production wallet identities and backend production mode skip RTP reads entirely, even if the environment switch is accidentally set.
- The bridge fails closed for new sandbox Provider rounds when enabled but the target is unreachable or invalid. Local/other wallet games retain existing calculation.

**This is not a guaranteed or mathematically certified RTP.** Player skill, hit rate, ability to cash out and selected difficulty affect actual returns. The multiplier display remains the original gameplay multiplier; the separate payout scaling is frozen and disclosed in backend settlement data. Record observed RTP per game, revision, casino and currency. Never interpret a target alone as an audit of house return.

## Sandbox procedure

Start with `GAME_PROVIDER_RTP_ENABLED=false`. Configure server-only `GAME_PROVIDER_RTP_ADAPTER_KEY` and `GAME_PROVIDER_RTP_API_URL`; set `GAME_PROVIDER_RTP_PROBE_ENABLED=true` for a **read-only** startup check. Only opt in to the isolated QA wallet after seeing a successful target fetch and a clean server boot. Never enable against a production-wallet deployment.

Tests: `node --test tests/provider-rtp-target.test.js tests/rtp-payout-lock.test.js`. Requires a separate real sandbox-wallet debit/settlement E2E check before declaring financially accepted.

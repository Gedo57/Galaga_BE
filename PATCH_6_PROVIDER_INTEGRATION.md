# Patch 6 — Galaga Backend / Game Provider

This branch adds an opt-in **PROVIDER** wallet path, without removing the existing LOCAL demo, SIDESIX, or PLATFORM integrations.

## Runtime configuration (Render staging only)

```env
GAME_PROVIDER_GALAGA_ENABLED=false
GAME_PROVIDER_API_URL=https://YOUR-GAME-PROVIDER.onrender.com
GAME_PROVIDER_GALAGA_ADAPTER_KEY=GENERATE_A_NEW_32_PLUS_CHARACTER_SECRET
```

Set `GAME_PROVIDER_GALAGA_ENABLED=true` **only** after configuring a sandbox operator wallet, persistent Provider state and matching key in the Provider Backend (`GAME_GALAGA_ADAPTER_KEY`). Never put adapter credentials on Vercel.

## Server-to-server contract

1. The browser sends `POST /api/platform/launch` with `providerLaunchToken` and `exchangeId`, without exposing operator API keys.
2. Galaga BE calls Provider `POST /api/v1/launch/consume` with `gameId: "galaga"`.
3. Player balance is read from Provider `POST /api/v1/wallet/balance`.
4. On `POST /api/sessions/start`, Galaga BE creates a server-side run ID and performs a single wallet `bet` debit (stable transaction ID); a failed/uncertain debit does not grant a paid run.
5. When the run reaches a cashout/legitimate final payout, Galaga BE sends one gross `win` payment referenced to the bet ID.
6. `POST /api/sessions/:id/abandon` before play performs a full `refund` referenced to the original bet; started/lost runs do not receive an automatic refund.
7. New provider-backed players are scoped by operator, player and launch ID; API ownership checks prohibit use of another launch.

Existing wave timing, scoring, checkpoint multipliers and anti-cheat validation are unchanged.

## Constraints and checks

- This code has been committed on `patch6/game-provider-galaga`, not merged to `main` or deployed to Render.
- `GAME_PROVIDER_GALAGA_ENABLED` defaults to false. Direct Vercel gameplay remains LOCAL demo.
- For real-money readiness, require formal settlement reconciliation, durable multi-process storage, concurrency controls, production security review, original Galaga tests and a full Staging browser playthrough with verified wallet balances and retries.
- Provider BE has separate mocked integration tests for launch, bet, win, refund and duplicate transactions; these do **not** establish a successful full-game E2E test.

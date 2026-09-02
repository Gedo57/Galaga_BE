# Galaga BE deployment

Target: Render Node web service.

`render.yaml` is included and creates a service named `galaga-be` with:

- Build: `npm install`
- Start: `npm start`
- Health check: `/api/health`
- Node: >=22.12 <23

`CORS_ORIGIN` should be `https://galaga-fe.vercel.app`. The server also includes this production origin as a safe built-in fallback, so a missing or stale Render environment variable does not break browser preflight requests.

The app currently stores wallet/session/telemetry state in `data/store.json`. Render's default filesystem is ephemeral, so production persistence requires a Render persistent disk or a database.

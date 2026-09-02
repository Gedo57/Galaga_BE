# Galaga BE deployment

Target: Render Node web service.

`render.yaml` is included and creates a service named `galaga-be` with:

- Build: `npm install`
- Start: `npm start`
- Health check: `/api/health`
- Node: >=22.12 <23

`CORS_ORIGIN` is initially `*` so the first Vercel deployment can connect without an origin mismatch. After the final Vercel production domain is known, tighten it to that exact origin in Render Environment settings.

The app currently stores wallet/session/telemetry state in `data/store.json`. Render's default filesystem is ephemeral, so production persistence requires a Render persistent disk or a database.

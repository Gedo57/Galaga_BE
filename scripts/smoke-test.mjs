import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

const port = 31991;
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(port), NODE_ENV: 'development', ADMIN_KEY: 'phase8-test', ANTI_CHEAT_MODE: 'enforce' },
  stdio: ['ignore', 'pipe', 'pipe']
});

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, { headers: { 'Content-Type': 'application/json', 'X-Client-Version': '0.8.0', ...(options.headers || {}) }, ...options });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

try {
  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    try {
      const { response } = await request('/api/health');
      if (response.ok) { ready = true; break; }
    } catch {}
    await wait(100);
  }
  if (!ready) throw new Error('Backend did not start');

  let out = await request('/api/dev/reset', { method: 'POST' });
  if (!out.response.ok) throw new Error(`Reset failed: ${JSON.stringify(out.payload)}`);

  out = await request('/api/health');
  if (!out.response.ok || out.payload.phase !== 8) throw new Error('Phase 8 health check failed');

  out = await request('/api/sessions/start', { method: 'POST', body: JSON.stringify({ playerId: 'demo-player', entryAmount: 50, difficulty: 'medium' }) });
  if (out.response.status !== 201) throw new Error(`Session start failed: ${JSON.stringify(out.payload)}`);
  const sessionId = out.payload.session.id;

  await request(`/api/sessions/${sessionId}/countdown`, { method: 'POST' });
  await request(`/api/sessions/${sessionId}/begin`, { method: 'POST' });

  out = await request(`/api/sessions/${sessionId}/core-state`, { method: 'POST', body: JSON.stringify({
    wave: 1, waveElapsed: 1, shotsFired: 4, shotsHit: 1,
    killsByType: { fighter: 1 }, bombKillsByType: {}, patternActivations: { singleDive: 0 }, bombUsed: false
  }) });
  if (!out.response.ok) throw new Error(`Normal snapshot should be accepted: ${JSON.stringify(out.payload)}`);

  out = await request(`/api/sessions/${sessionId}/core-state`, { method: 'POST', body: JSON.stringify({
    wave: 1, waveElapsed: 1.1, shotsFired: 9999, shotsHit: 1, killsByType: { fighter: 1 }, bombKillsByType: {}, patternActivations: { singleDive: 0 }
  }) });
  if (out.response.status !== 422) throw new Error(`Anti-cheat smoke check expected 422, got ${out.response.status}`);

  out = await request('/api/admin/telemetry/summary', { headers: { 'X-Admin-Key': 'phase8-test' } });
  if (!out.response.ok || out.payload.runs.total < 1 || out.payload.antiCheat.flaggedSessions < 1) throw new Error('Telemetry summary smoke check failed');

  await request(`/api/sessions/${sessionId}/abandon`, { method: 'POST' });
  await request('/api/dev/reset', { method: 'POST' });
  console.log('Phase 8 backend smoke test passed.');
} finally {
  child.kill('SIGTERM');
}

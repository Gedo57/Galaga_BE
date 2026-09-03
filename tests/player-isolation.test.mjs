import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('different browser player IDs keep independent active sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'galaga-player-isolation-'));
  const storePath = join(dir, 'store.json');
  writeFileSync(storePath, JSON.stringify({ players: {}, sessions: {}, transactions: [], telemetry: { version: 1, events: [] } }, null, 2));

  const previousStorePath = process.env.STORE_PATH;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.STORE_PATH = storePath;
  process.env.NODE_ENV = 'development';

  const { server } = await import(`../src/server.js?player-isolation=${Date.now()}`);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Client-Version': 'test' };

  async function call(path, options = {}) {
    const response = await fetch(base + path, { headers, ...options });
    const payload = await response.json();
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(payload)}`);
    return payload;
  }

  try {
    const playerA = 'player-aaaaaaaaaaaa-111111111111';
    const playerB = 'player-bbbbbbbbbbbb-222222222222';

    await call('/api/players/ensure', { method: 'POST', body: JSON.stringify({ playerId: playerA }) });
    await call('/api/players/ensure', { method: 'POST', body: JSON.stringify({ playerId: playerB }) });

    const aStart = await call('/api/sessions/start', { method: 'POST', body: JSON.stringify({ playerId: playerA, entryAmount: 50, difficulty: 'medium' }) });
    const bStart = await call('/api/sessions/start', { method: 'POST', body: JSON.stringify({ playerId: playerB, entryAmount: 50, difficulty: 'medium' }) });

    const aRead = await call(`/api/players/${encodeURIComponent(playerA)}`);
    const bRead = await call(`/api/players/${encodeURIComponent(playerB)}`);

    assert.notEqual(aStart.session.id, bStart.session.id);
    assert.equal(aRead.activeSession.id, aStart.session.id);
    assert.equal(bRead.activeSession.id, bStart.session.id);
    assert.equal(aRead.activeSession.playerId, playerA);
    assert.equal(bRead.activeSession.playerId, playerB);
    assert.equal(aRead.player.balance, 4950);
    assert.equal(bRead.player.balance, 4950);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
    if (previousStorePath === undefined) delete process.env.STORE_PATH; else process.env.STORE_PATH = previousStorePath;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
  }
});

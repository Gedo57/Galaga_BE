import { randomBytes } from 'node:crypto';

const sessions = new Map();
const TTL_MS = 12 * 60 * 60 * 1000;

export const platformSessionStore = {
  create(identity) {
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { ...identity, createdAt: Date.now(), expiresAt: Date.now() + TTL_MS });
    return { token, identity: { ...identity } };
  },
  get(token) {
    const item = sessions.get(token);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return { ...item };
  },
};

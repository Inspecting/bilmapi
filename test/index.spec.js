import { beforeEach, describe, expect, it } from 'vitest';
import { createWorker } from '../src/index.js';

const USER_ID = '12345678901234567890123456';
const OTHER_USER_ID = 'abcdefghijklmnopqrstuvwxyz12';
const ALLOWED_ORIGIN = 'https://watchbilm.org';
const DISALLOWED_ORIGIN = 'https://evil.example';

class MemoryKv {
  constructor() {
    this.map = new Map();
  }

  async put(key, value, options = {}) {
    this.map.set(String(key), {
      value: value === null || typeof value === 'undefined' ? null : String(value),
      metadata: options?.metadata || null
    });
  }

  async get(key) {
    const item = this.map.get(String(key));
    return item ? item.value : null;
  }

  async getWithMetadata(key) {
    const item = this.map.get(String(key));
    return {
      value: item ? item.value : null,
      metadata: item?.metadata || null
    };
  }
}

class MemoryD1Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = String(sql || '').toLowerCase().replace(/\s+/g, ' ').trim();
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async run() {
    if (this.sql.startsWith('insert into user_snapshots')) {
      const [userId, snapshotJson, updatedAtMs, deviceId, schema, savedAt] = this.params;
      this.db.rows.set(String(userId), {
        user_id: String(userId),
        snapshot_json: String(snapshotJson),
        updated_at_ms: Number(updatedAtMs || 0) || 0,
        device_id: deviceId || null,
        schema: schema || null,
        saved_at: String(savedAt || '')
      });
      return { success: true };
    }

    if (this.sql.startsWith('insert into list_sync_items')) {
      const [userId, listKey, itemKey, itemJson, updatedAtMs, deletedAtMs, deviceId, savedAt] = this.params;
      const normalizedUserId = String(userId || '');
      const normalizedListKey = String(listKey || '');
      const normalizedItemKey = String(itemKey || '');
      const compositeKey = `${normalizedUserId}|${normalizedListKey}|${normalizedItemKey}`;
      const incomingUpdatedAt = Number(updatedAtMs || 0) || 0;
      const current = this.db.listRows.get(compositeKey);
      if (current && Number(current.updated_at_ms || 0) > incomingUpdatedAt) {
        return { success: true };
      }
      this.db.listRows.set(compositeKey, {
        user_id: normalizedUserId,
        list_key: normalizedListKey,
        item_key: normalizedItemKey,
        item_json: itemJson === null || typeof itemJson === 'undefined' ? null : String(itemJson),
        updated_at_ms: incomingUpdatedAt,
        deleted_at_ms: deletedAtMs === null || typeof deletedAtMs === 'undefined'
          ? null
          : (Number(deletedAtMs || 0) || 0),
        device_id: deviceId || null,
        saved_at: String(savedAt || '')
      });
      return { success: true };
    }

    throw new Error(`Unsupported D1 run SQL in test: ${this.sql}`);
  }

  async first() {
    const userId = String(this.params[0] || '');
    const row = this.db.rows.get(userId);
    if (!row) return null;

    if (this.sql.includes('select snapshot_json')) {
      return {
        snapshot_json: row.snapshot_json,
        updated_at_ms: row.updated_at_ms,
        device_id: row.device_id,
        schema: row.schema
      };
    }

    if (this.sql.includes('select updated_at_ms')) {
      return {
        updated_at_ms: row.updated_at_ms,
        device_id: row.device_id,
        schema: row.schema
      };
    }

    throw new Error(`Unsupported D1 first SQL in test: ${this.sql}`);
  }

  async all() {
    if (this.sql.includes('from list_sync_items')) {
      const [userId, sinceMs, limit] = this.params;
      const normalizedUserId = String(userId || '');
      const since = Number(sinceMs || 0) || 0;
      const max = Number(limit || 250) || 250;
      const results = [...this.db.listRows.values()]
        .filter((row) => row.user_id === normalizedUserId && Number(row.updated_at_ms || 0) > since)
        .sort((a, b) => Number(a.updated_at_ms || 0) - Number(b.updated_at_ms || 0))
        .slice(0, Math.max(1, max))
        .map((row) => ({
          list_key: row.list_key,
          item_key: row.item_key,
          item_json: row.item_json,
          updated_at_ms: row.updated_at_ms,
          deleted_at_ms: row.deleted_at_ms
        }));
      return { results };
    }

    throw new Error(`Unsupported D1 all SQL in test: ${this.sql}`);
  }
}

class MemoryD1 {
  constructor() {
    this.rows = new Map();
    this.listRows = new Map();
  }

  prepare(sql) {
    return new MemoryD1Statement(this, sql);
  }
}

function createEnv({ kv = new MemoryKv(), d1 = new MemoryD1() } = {}) {
  return {
    BILM_DATA: kv,
    BILM_DB: d1,
    FIREBASE_PROJECT_ID: 'bilm-7bfe1',
    BILM_ADMIN_TOKEN: 'top-secret-token'
  };
}

function createVerifier() {
  return async (token) => {
    if (token === 'valid-token') return { sub: USER_ID };
    if (token === 'other-token') return { sub: OTHER_USER_ID };
    throw new Error('invalid token');
  };
}

describe('bilm backend api', () => {
  let kv;
  let d1;
  let env;
  let worker;

  beforeEach(() => {
    kv = new MemoryKv();
    d1 = new MemoryD1();
    env = createEnv({ kv, d1 });
    worker = createWorker({ verifyIdToken: createVerifier() });
  });

  it('saves and retrieves snapshot with valid auth', async () => {
    const payload = {
      schema: 'bilm-backup-v1',
      meta: {
        updatedAtMs: 1710000000000,
        deviceId: 'device-a'
      },
      localStorage: {
        'bilm-shared-chat': '[]'
      }
    };

    const saveResponse = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token',
        origin: ALLOWED_ORIGIN
      },
      body: JSON.stringify({ userId: USER_ID, data: payload })
    }), env);

    expect(saveResponse.status).toBe(200);
    expect(saveResponse.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(d1.rows.has(USER_ID)).toBe(true);

    const loadResponse = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`, {
      method: 'GET',
      headers: {
        authorization: 'Bearer valid-token',
        origin: ALLOWED_ORIGIN
      }
    }), env);

    expect(loadResponse.status).toBe(200);
    const loaded = await loadResponse.json();
    expect(loaded.meta.updatedAtMs).toBe(1710000000000);
    expect(loaded.meta.deviceId).toBe('device-a');
  });

  it('returns snapshot metadata from meta route (D1)', async () => {
    d1.rows.set(USER_ID, {
      user_id: USER_ID,
      snapshot_json: JSON.stringify({ schema: 'bilm-backup-v1' }),
      updated_at_ms: 1711234567890,
      device_id: 'meta-device',
      schema: 'bilm-backup-v1',
      saved_at: new Date().toISOString()
    });

    const response = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}&meta=true`, {
      headers: { authorization: 'Bearer valid-token' }
    }), env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.exists).toBe(true);
    expect(body.updatedAtMs).toBe(1711234567890);
    expect(body.deviceId).toBe('meta-device');
  });

  it('falls back to kv when D1 has no row', async () => {
    const fallbackPayload = {
      schema: 'bilm-backup-v1',
      meta: { updatedAtMs: 1713333333333, deviceId: 'kv-device' }
    };
    await kv.put(`user-${USER_ID}`, JSON.stringify(fallbackPayload), {
      metadata: fallbackPayload.meta
    });

    const response = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`, {
      headers: { authorization: 'Bearer valid-token' }
    }), env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.meta.deviceId).toBe('kv-device');
  });

  it('returns 401 for missing or invalid token', async () => {
    const missing = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`), env);
    expect(missing.status).toBe(401);

    const invalid = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`, {
      headers: { authorization: 'Bearer bad-token' }
    }), env);
    expect(invalid.status).toBe(401);
  });

  it('returns 403 when token sub does not match userId', async () => {
    const response = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`, {
      headers: { authorization: 'Bearer other-token' }
    }), env);
    expect(response.status).toBe(403);
  });

  it('returns 404 for missing snapshot on full GET', async () => {
    const response = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`, {
      headers: { authorization: 'Bearer valid-token' }
    }), env);

    expect(response.status).toBe(404);
  });

  it('applies cors only for allowed origins and handles preflight', async () => {
    const allowedPreflight = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED_ORIGIN }
    }), env);
    expect(allowedPreflight.status).toBe(204);
    expect(allowedPreflight.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);

    const blockedPreflight = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`, {
      method: 'OPTIONS',
      headers: { origin: DISALLOWED_ORIGIN }
    }), env);
    expect(blockedPreflight.status).toBe(204);
    expect(blockedPreflight.headers.get('access-control-allow-origin')).toBeNull();

    const response = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`, {
      headers: {
        authorization: 'Bearer valid-token',
        origin: DISALLOWED_ORIGIN
      }
    }), env);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects payloads that contain credential-like fields', async () => {
    const response = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        data: {
          schema: 'bilm-backup-v1',
          auth_token: 'do-not-store'
        }
      })
    }), env);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('credential_storage_forbidden');
  });

  it('pushes and pulls incremental list sync operations', async () => {
    const pushResponse = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/lists/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        operations: [
          {
            listKey: 'bilm-watch-history',
            itemKey: 'movie:10',
            updatedAtMs: 1721000000000,
            deleted: false,
            payload: { key: 'movie-10', type: 'movie', id: 10, updatedAt: 1721000000000 }
          },
          {
            listKey: 'bilm-watch-history',
            itemKey: 'movie:9',
            updatedAtMs: 1721000000100,
            deleted: true
          }
        ]
      })
    }), env);

    expect(pushResponse.status).toBe(200);
    const pushBody = await pushResponse.json();
    expect(pushBody.ok).toBe(true);
    expect(pushBody.processed).toBe(2);
    expect(pushBody.cursorMs).toBe(1721000000100);

    const pullResponse = await worker.fetch(new Request(`https://data-api.watchbilm.org/sync/lists/pull?userId=${USER_ID}&since=0`, {
      method: 'GET',
      headers: { authorization: 'Bearer valid-token' }
    }), env);

    expect(pullResponse.status).toBe(200);
    const pullBody = await pullResponse.json();
    expect(pullBody.ok).toBe(true);
    expect(Array.isArray(pullBody.operations)).toBe(true);
    expect(pullBody.operations.length).toBe(2);
    expect(pullBody.operations[0].listKey).toBe('bilm-watch-history');
    expect(pullBody.operations[0].deleted).toBe(false);
    expect(pullBody.operations[1].deleted).toBe(true);
  });

  it('does not let stale upserts resurrect newer tombstones', async () => {
    const deleteNewer = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/lists/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        operations: [
          {
            listKey: 'bilm-continue-watching',
            itemKey: 'tv:22',
            updatedAtMs: 1722000000200,
            deleted: true
          }
        ]
      })
    }), env);
    expect(deleteNewer.status).toBe(200);

    const staleUpsert = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/lists/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        operations: [
          {
            listKey: 'bilm-continue-watching',
            itemKey: 'tv:22',
            updatedAtMs: 1722000000100,
            deleted: false,
            payload: { key: 'tv-22', type: 'tv', id: 22, updatedAt: 1722000000100 }
          }
        ]
      })
    }), env);
    expect(staleUpsert.status).toBe(200);

    const pull = await worker.fetch(new Request(`https://data-api.watchbilm.org/sync/lists/pull?userId=${USER_ID}&since=0`, {
      method: 'GET',
      headers: { authorization: 'Bearer valid-token' }
    }), env);

    expect(pull.status).toBe(200);
    const body = await pull.json();
    expect(body.operations.length).toBe(1);
    expect(body.operations[0].deleted).toBe(true);
    expect(body.operations[0].updatedAtMs).toBe(1722000000200);
  });

  it('requires auth on list sync routes', async () => {
    const push = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/lists/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: USER_ID,
        operations: []
      })
    }), env);
    expect(push.status).toBe(401);

    const pull = await worker.fetch(new Request(`https://data-api.watchbilm.org/sync/lists/pull?userId=${USER_ID}&since=0`), env);
    expect(pull.status).toBe(401);
  });

  it('imports snapshots into D1 when admin token is valid', async () => {
    const response = await worker.fetch(new Request('https://data-api.watchbilm.org/?bulk=true', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': 'top-secret-token'
      },
      body: JSON.stringify({
        [USER_ID]: { schema: 'bilm-backup-v1', meta: { updatedAtMs: 1720000000000 } }
      })
    }), env);

    expect(response.status).toBe(200);
    expect(d1.rows.has(USER_ID)).toBe(true);
  });

  it('rejects import and bulk routes without valid admin token', async () => {
    const importMissing = await worker.fetch(new Request('https://data-api.watchbilm.org/?import=true', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ users: {} })
    }), env);
    expect(importMissing.status).toBe(401);

    const bulkWrong = await worker.fetch(new Request('https://data-api.watchbilm.org/?bulk=true', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': 'wrong-token'
      },
      body: JSON.stringify({ [USER_ID]: { schema: 'bilm-backup-v1' } })
    }), env);
    expect(bulkWrong.status).toBe(403);
  });
});

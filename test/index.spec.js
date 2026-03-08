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

function createEnv(kv) {
  return {
    BILM_DATA: kv,
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
  let env;
  let worker;

  beforeEach(() => {
    kv = new MemoryKv();
    env = createEnv(kv);
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

    const saveResponse = await worker.fetch(new Request('https://data-api.watchbilm.org/?userId=' + USER_ID, {
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

    const loadResponse = await worker.fetch(new Request('https://data-api.watchbilm.org/?userId=' + USER_ID, {
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

  it('returns snapshot metadata from meta route', async () => {
    await kv.put(`user-${USER_ID}`, JSON.stringify({ schema: 'bilm-backup-v1' }), {
      metadata: {
        updatedAtMs: 1711234567890,
        deviceId: 'meta-device',
        schema: 'bilm-backup-v1'
      }
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
    const allowedPreflight = await worker.fetch(new Request('https://data-api.watchbilm.org/?userId=' + USER_ID, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED_ORIGIN }
    }), env);
    expect(allowedPreflight.status).toBe(204);
    expect(allowedPreflight.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);

    const blockedPreflight = await worker.fetch(new Request('https://data-api.watchbilm.org/?userId=' + USER_ID, {
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

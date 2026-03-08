import { createRemoteJWKSet, jwtVerify } from 'jose';

const DEFAULT_PROJECT_ID = 'bilm-7bfe1';
const FIREBASE_ISSUER_BASE = 'https://securetoken.google.com';
const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const UPSERT_SNAPSHOT_SQL = `
  INSERT INTO user_snapshots (user_id, snapshot_json, updated_at_ms, device_id, schema, saved_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  ON CONFLICT(user_id) DO UPDATE SET
    snapshot_json = excluded.snapshot_json,
    updated_at_ms = excluded.updated_at_ms,
    device_id = excluded.device_id,
    schema = excluded.schema,
    saved_at = excluded.saved_at
`;
const SELECT_SNAPSHOT_SQL = `
  SELECT snapshot_json, updated_at_ms, device_id, schema
  FROM user_snapshots
  WHERE user_id = ?1
  LIMIT 1
`;
const SELECT_SNAPSHOT_META_SQL = `
  SELECT updated_at_ms, device_id, schema
  FROM user_snapshots
  WHERE user_id = ?1
  LIMIT 1
`;
const DISALLOWED_CREDENTIAL_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'passworddigest',
  'password_digest',
  'passwd',
  'passphrase',
  'salt',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'id_token',
  'idtoken',
  'session_token',
  'sessiontoken',
  'auth_token',
  'authtoken',
  'jwt'
]);
const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://watchbilm.org',
  'https://bilm.fly.dev',
  'https://inspecting.github.io',
  'https://data-api.watchbilm.org',
  'https://bilm-backend.reidmhit.workers.dev'
]);

const firebaseJwks = createRemoteJWKSet(new URL(FIREBASE_JWKS_URL));

function getProjectId(env) {
  return String(env?.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID).trim() || DEFAULT_PROJECT_ID;
}

function getD1Database(env) {
  const db = env?.BILM_DB;
  return db && typeof db.prepare === 'function' ? db : null;
}

function getKvNamespace(env) {
  const kv = env?.BILM_DATA;
  return kv && typeof kv.get === 'function' ? kv : null;
}

function normalizeUserId(value) {
  return String(value || '').trim().replace(/^user-/i, '');
}

function isValidUserId(userId) {
  const normalized = normalizeUserId(userId);
  return normalized.length >= 25 && normalized.length <= 30;
}

function createCorsHeaders(corsOrigin = '') {
  if (!corsOrigin) return {};
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function jsonResponse(status, payload, corsOrigin = '', extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...createCorsHeaders(corsOrigin),
      ...extraHeaders
    }
  });
}

function textResponse(status, text, corsOrigin = '', extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...createCorsHeaders(corsOrigin),
      ...extraHeaders
    }
  });
}

async function parseJsonBody(request, corsOrigin) {
  try {
    return await request.json();
  } catch {
    throw jsonResponse(400, { error: 'invalid_json', message: 'Request body must be valid JSON.' }, corsOrigin);
  }
}

function getBearerToken(request) {
  const header = request.headers.get('authorization');
  if (!header) return '';
  const [scheme, token] = header.split(/\s+/, 2);
  if (String(scheme || '').toLowerCase() !== 'bearer') return '';
  return String(token || '').trim();
}

async function verifyFirebaseIdToken(token, { projectId }) {
  const { payload } = await jwtVerify(token, firebaseJwks, {
    audience: projectId,
    issuer: `${FIREBASE_ISSUER_BASE}/${projectId}`
  });
  return payload;
}

function classifyAuthFailure(error) {
  const code = String(error?.code || '').toLowerCase();
  if (code.includes('jwt_expired')) {
    return { error: 'token_expired', message: 'Firebase token has expired.' };
  }
  return { error: 'invalid_token', message: 'Firebase token verification failed.' };
}

function getSnapshotMetadata(snapshot) {
  const normalized = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const updatedAtMs = Number(normalized?.meta?.updatedAtMs || Date.now()) || Date.now();
  const deviceId = String(normalized?.meta?.deviceId || '').trim() || null;
  const schema = String(normalized?.schema || '').trim() || null;
  return {
    updatedAtMs,
    deviceId,
    schema,
    savedAt: new Date().toISOString()
  };
}

function normalizeCredentialKey(key) {
  return String(key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function assertNoCredentialStorage(payload, corsOrigin) {
  if (!payload || typeof payload !== 'object') return;

  const stack = [payload];
  let inspected = 0;
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    inspected += 1;
    if (inspected > 5000) break;

    for (const [rawKey, rawValue] of Object.entries(current)) {
      const key = normalizeCredentialKey(rawKey);
      if (
        DISALLOWED_CREDENTIAL_KEYS.has(key) &&
        rawValue !== null &&
        typeof rawValue !== 'undefined' &&
        String(rawValue).trim() !== ''
      ) {
        throw jsonResponse(400, {
          error: 'credential_storage_forbidden',
          message: 'Credential-like fields are not allowed in snapshot storage.'
        }, corsOrigin);
      }
      if (rawValue && typeof rawValue === 'object') stack.push(rawValue);
    }
  }
}

async function requireSnapshotAuth({ request, corsOrigin, env, verifyIdToken, userId }) {
  const token = getBearerToken(request);
  if (!token) {
    throw jsonResponse(401, { error: 'missing_token', message: 'Authorization Bearer token is required.' }, corsOrigin);
  }

  let payload;
  try {
    payload = await verifyIdToken(token, { projectId: getProjectId(env) });
  } catch (error) {
    const detail = classifyAuthFailure(error);
    throw jsonResponse(401, detail, corsOrigin);
  }

  const subject = String(payload?.sub || '').trim();
  const normalizedUserId = normalizeUserId(userId);
  if (!subject || subject !== normalizedUserId) {
    throw jsonResponse(403, { error: 'forbidden', message: 'Token subject does not match requested userId.' }, corsOrigin);
  }

  return payload;
}

function requireAdminToken({ request, corsOrigin, env }) {
  const configuredToken = String(env?.BILM_ADMIN_TOKEN || '').trim();
  if (!configuredToken) {
    throw jsonResponse(503, { error: 'admin_token_not_configured', message: 'Admin token is not configured on the worker.' }, corsOrigin);
  }

  const provided = String(request.headers.get('x-admin-token') || '').trim();
  if (!provided) {
    throw jsonResponse(401, { error: 'missing_admin_token', message: 'x-admin-token header is required.' }, corsOrigin);
  }
  if (provided !== configuredToken) {
    throw jsonResponse(403, { error: 'invalid_admin_token', message: 'Admin token is invalid.' }, corsOrigin);
  }
}

function assertStorageConfigured(env, corsOrigin) {
  if (!getD1Database(env) && !getKvNamespace(env)) {
    throw jsonResponse(503, {
      error: 'storage_not_configured',
      message: 'No storage backend is configured. Bind BILM_DB (D1) and/or BILM_DATA (KV).'
    }, corsOrigin);
  }
}

async function writeSnapshotToD1({ env, userId, snapshotJson, metadata }) {
  const db = getD1Database(env);
  if (!db) return false;
  await db
    .prepare(UPSERT_SNAPSHOT_SQL)
    .bind(
      userId,
      snapshotJson,
      metadata.updatedAtMs,
      metadata.deviceId,
      metadata.schema,
      metadata.savedAt
    )
    .run();
  return true;
}

async function writeSnapshotToKv({ env, userId, snapshotJson, metadata }) {
  const kv = getKvNamespace(env);
  if (!kv) return false;
  await kv.put(`user-${userId}`, snapshotJson, { metadata });
  return true;
}

async function persistSnapshot({ env, userId, snapshot, corsOrigin }) {
  assertNoCredentialStorage(snapshot, corsOrigin);

  const metadata = getSnapshotMetadata(snapshot);
  const snapshotJson = JSON.stringify(snapshot || {});
  let stored = false;

  if (await writeSnapshotToD1({ env, userId, snapshotJson, metadata })) {
    stored = true;
  }

  if (await writeSnapshotToKv({ env, userId, snapshotJson, metadata })) {
    stored = true;
  }

  if (!stored) {
    throw jsonResponse(503, {
      error: 'storage_not_configured',
      message: 'No storage backend is configured. Bind BILM_DB (D1) and/or BILM_DATA (KV).'
    }, corsOrigin);
  }
}

async function readSnapshotValue({ env, userId }) {
  const db = getD1Database(env);
  if (db) {
    const row = await db.prepare(SELECT_SNAPSHOT_SQL).bind(userId).first();
    if (row && typeof row.snapshot_json === 'string') {
      return row.snapshot_json;
    }
  }

  const kv = getKvNamespace(env);
  if (kv) {
    return await kv.get(`user-${userId}`);
  }

  return null;
}

async function readSnapshotMeta({ env, userId }) {
  const db = getD1Database(env);
  if (db) {
    const row = await db.prepare(SELECT_SNAPSHOT_META_SQL).bind(userId).first();
    if (row) {
      return {
        exists: true,
        updatedAtMs: Number(row.updated_at_ms || 0) || null,
        deviceId: String(row.device_id || '').trim() || null,
        schema: String(row.schema || '').trim() || null
      };
    }
  }

  const kv = getKvNamespace(env);
  if (kv) {
    const { value, metadata } = await kv.getWithMetadata(`user-${userId}`, 'text');
    return {
      exists: value !== null,
      updatedAtMs: Number(metadata?.updatedAtMs || 0) || null,
      deviceId: String(metadata?.deviceId || '').trim() || null,
      schema: String(metadata?.schema || '').trim() || null
    };
  }

  return {
    exists: false,
    updatedAtMs: null,
    deviceId: null,
    schema: null
  };
}

async function handleImportRequest({ request, env, corsOrigin }) {
  assertStorageConfigured(env, corsOrigin);
  requireAdminToken({ request, corsOrigin, env });
  const data = await parseJsonBody(request, corsOrigin);
  const writes = [];
  let count = 0;

  for (const documents of Object.values(data || {})) {
    if (!documents || typeof documents !== 'object') continue;
    for (const [docId, docData] of Object.entries(documents)) {
      const userId = normalizeUserId(docId);
      if (!isValidUserId(userId)) {
        throw jsonResponse(400, { error: 'invalid_user_id', message: `Invalid userId: ${docId}` }, corsOrigin);
      }
      writes.push(persistSnapshot({ env, userId, snapshot: docData || {}, corsOrigin }));
      count += 1;
      if (writes.length >= 25) {
        await Promise.all(writes);
        writes.length = 0;
      }
    }
  }

  if (writes.length) await Promise.all(writes);
  return jsonResponse(200, { ok: true, imported: count }, corsOrigin);
}

async function handleBulkImportRequest({ request, env, corsOrigin }) {
  assertStorageConfigured(env, corsOrigin);
  requireAdminToken({ request, corsOrigin, env });
  const data = await parseJsonBody(request, corsOrigin);
  const writes = [];
  let count = 0;

  for (const [docId, docData] of Object.entries(data || {})) {
    const userId = normalizeUserId(docId);
    if (!isValidUserId(userId)) continue;
    writes.push(persistSnapshot({ env, userId, snapshot: docData || {}, corsOrigin }));
    count += 1;
    if (writes.length >= 25) {
      await Promise.all(writes);
      writes.length = 0;
    }
  }

  if (writes.length) await Promise.all(writes);
  return jsonResponse(200, { ok: true, imported: count }, corsOrigin);
}

async function handleGetSnapshot({ request, env, corsOrigin, verifyIdToken }) {
  assertStorageConfigured(env, corsOrigin);
  const url = new URL(request.url);
  const userId = normalizeUserId(url.searchParams.get('userId'));
  if (!isValidUserId(userId)) {
    return jsonResponse(400, { error: 'invalid_user_id', message: 'Invalid or missing userId.' }, corsOrigin);
  }

  await requireSnapshotAuth({ request, corsOrigin, env, verifyIdToken, userId });

  const wantsMeta = url.searchParams.get('meta') === 'true';

  if (wantsMeta) {
    return jsonResponse(200, await readSnapshotMeta({ env, userId }), corsOrigin);
  }

  const value = await readSnapshotValue({ env, userId });
  if (value === null) {
    return jsonResponse(404, { error: 'not_found', message: 'No snapshot found for this user.' }, corsOrigin);
  }

  return textResponse(200, value, corsOrigin);
}

async function handleSaveSnapshot({ request, env, corsOrigin, verifyIdToken }) {
  assertStorageConfigured(env, corsOrigin);
  const body = await parseJsonBody(request, corsOrigin);
  const userId = normalizeUserId(body?.userId);
  if (!isValidUserId(userId)) {
    return jsonResponse(400, { error: 'invalid_user_id', message: 'Invalid or missing userId.' }, corsOrigin);
  }

  await requireSnapshotAuth({ request, corsOrigin, env, verifyIdToken, userId });

  if (typeof body?.data === 'undefined') {
    return jsonResponse(400, { error: 'missing_data', message: 'Snapshot data is required.' }, corsOrigin);
  }

  const payload = body.data;
  await persistSnapshot({ env, userId, snapshot: payload, corsOrigin });

  return jsonResponse(200, { ok: true, saved: true }, corsOrigin);
}

export function createWorker({ verifyIdToken = verifyFirebaseIdToken, allowedOrigins = DEFAULT_ALLOWED_ORIGINS } = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const origin = request.headers.get('origin');
      const corsOrigin = origin && allowedOrigins.has(origin) ? origin : '';

      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            ...createCorsHeaders(corsOrigin),
            allow: 'GET, POST, OPTIONS'
          }
        });
      }

      try {
        if (request.method === 'POST' && url.searchParams.get('import') === 'true') {
          return await handleImportRequest({ request, env, corsOrigin });
        }

        if (request.method === 'POST' && url.searchParams.get('bulk') === 'true') {
          return await handleBulkImportRequest({ request, env, corsOrigin });
        }

        if (request.method === 'GET') {
          return await handleGetSnapshot({ request, env, corsOrigin, verifyIdToken });
        }

        if (request.method === 'POST') {
          return await handleSaveSnapshot({ request, env, corsOrigin, verifyIdToken });
        }

        return jsonResponse(405, { error: 'method_not_allowed', message: 'Method not allowed.' }, corsOrigin, {
          allow: 'GET, POST, OPTIONS'
        });
      } catch (error) {
        if (error instanceof Response) return error;
        return jsonResponse(500, { error: 'internal_error', message: 'Unexpected server error.' }, corsOrigin);
      }
    }
  };
}

export default createWorker();

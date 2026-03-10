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
const UPSERT_LIST_SYNC_ITEM_SQL = `
  INSERT INTO list_sync_items (
    user_id,
    list_key,
    item_key,
    item_json,
    updated_at_ms,
    deleted_at_ms,
    device_id,
    saved_at
  )
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
  ON CONFLICT(user_id, list_key, item_key) DO UPDATE SET
    item_json = excluded.item_json,
    updated_at_ms = excluded.updated_at_ms,
    deleted_at_ms = excluded.deleted_at_ms,
    device_id = excluded.device_id,
    saved_at = excluded.saved_at
  WHERE excluded.updated_at_ms > list_sync_items.updated_at_ms
    OR (
      excluded.updated_at_ms = list_sync_items.updated_at_ms
      AND COALESCE(excluded.deleted_at_ms, 0) >= COALESCE(list_sync_items.deleted_at_ms, 0)
    )
`;
const UPSERT_SECTOR_SYNC_ITEM_SQL = `
  INSERT INTO sync_items (
    user_id,
    sector_key,
    item_key,
    item_json,
    updated_at_ms,
    deleted_at_ms,
    device_id,
    op_id,
    saved_at
  )
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
  ON CONFLICT(user_id, sector_key, item_key) DO UPDATE SET
    item_json = excluded.item_json,
    updated_at_ms = excluded.updated_at_ms,
    deleted_at_ms = excluded.deleted_at_ms,
    device_id = excluded.device_id,
    op_id = excluded.op_id,
    saved_at = excluded.saved_at
  WHERE excluded.updated_at_ms > sync_items.updated_at_ms
    OR (
      excluded.updated_at_ms = sync_items.updated_at_ms
      AND (
        COALESCE(excluded.deleted_at_ms, 0) > COALESCE(sync_items.deleted_at_ms, 0)
        OR (
          COALESCE(excluded.deleted_at_ms, 0) = COALESCE(sync_items.deleted_at_ms, 0)
          AND COALESCE(excluded.op_id, '') >= COALESCE(sync_items.op_id, '')
        )
      )
    )
`;
const SELECT_SECTOR_SYNC_CHANGES_BASE_SQL = `
  SELECT sector_key, item_key, item_json, updated_at_ms, deleted_at_ms, op_id
  FROM sync_items
  WHERE user_id = ?1
    AND updated_at_ms > ?2
`;
const UPSERT_USER_SYNC_STATE_SQL = `
  INSERT INTO user_sync_state (
    user_id,
    migrated_at_ms,
    migration_source,
    updated_at_ms,
    saved_at
  )
  VALUES (?1, ?2, ?3, ?4, ?5)
  ON CONFLICT(user_id) DO UPDATE SET
    migrated_at_ms = COALESCE(user_sync_state.migrated_at_ms, excluded.migrated_at_ms),
    migration_source = COALESCE(user_sync_state.migration_source, excluded.migration_source),
    updated_at_ms = excluded.updated_at_ms,
    saved_at = excluded.saved_at
`;
const SELECT_USER_SYNC_STATE_SQL = `
  SELECT migrated_at_ms, migration_source, updated_at_ms
  FROM user_sync_state
  WHERE user_id = ?1
  LIMIT 1
`;
const PURGE_OLD_SECTOR_TOMBSTONES_SQL = `
  DELETE FROM sync_items
  WHERE deleted_at_ms IS NOT NULL
    AND deleted_at_ms > 0
    AND deleted_at_ms < ?1
`;
const PURGE_OLD_LIST_TOMBSTONES_SQL = `
  DELETE FROM list_sync_items
  WHERE deleted_at_ms IS NOT NULL
    AND deleted_at_ms > 0
    AND deleted_at_ms < ?1
`;
const SELECT_LIST_SYNC_CHANGES_SQL = `
  SELECT list_key, item_key, item_json, updated_at_ms, deleted_at_ms
  FROM list_sync_items
  WHERE user_id = ?1
    AND updated_at_ms > ?2
  ORDER BY updated_at_ms ASC
  LIMIT ?3
`;
const SELECT_MEDIA_CACHE_ENTRY_SQL = `
  SELECT
    cache_key,
    provider,
    resource_type,
    status_code,
    content_type,
    payload_inline_json,
    payload_r2_key,
    fetched_at_ms,
    expires_at_ms,
    stale_until_ms,
    hit_count,
    last_hit_at_ms
  FROM media_cache_entries
  WHERE cache_key = ?1
  LIMIT 1
`;
const UPSERT_MEDIA_CACHE_ENTRY_SQL = `
  INSERT INTO media_cache_entries (
    cache_key,
    provider,
    resource_type,
    query_text,
    status_code,
    content_type,
    payload_inline_json,
    payload_r2_key,
    fetched_at_ms,
    expires_at_ms,
    stale_until_ms,
    hit_count,
    last_hit_at_ms
  )
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
  ON CONFLICT(cache_key) DO UPDATE SET
    provider = excluded.provider,
    resource_type = excluded.resource_type,
    query_text = excluded.query_text,
    status_code = excluded.status_code,
    content_type = excluded.content_type,
    payload_inline_json = excluded.payload_inline_json,
    payload_r2_key = excluded.payload_r2_key,
    fetched_at_ms = excluded.fetched_at_ms,
    expires_at_ms = excluded.expires_at_ms,
    stale_until_ms = excluded.stale_until_ms,
    hit_count = excluded.hit_count,
    last_hit_at_ms = excluded.last_hit_at_ms
`;
const TOUCH_MEDIA_CACHE_ENTRY_SQL = `
  UPDATE media_cache_entries
  SET hit_count = COALESCE(hit_count, 0) + 1,
      last_hit_at_ms = ?2
  WHERE cache_key = ?1
`;
const UPSERT_MEDIA_QUERY_METRIC_SQL = `
  INSERT INTO media_query_metrics (
    provider,
    resource_type,
    query_text,
    hit_count,
    last_seen_at_ms
  )
  VALUES (?1, ?2, ?3, 1, ?4)
  ON CONFLICT(provider, resource_type, query_text) DO UPDATE SET
    hit_count = media_query_metrics.hit_count + 1,
    last_seen_at_ms = excluded.last_seen_at_ms
`;
const ACQUIRE_MEDIA_REFRESH_LOCK_SQL = `
  INSERT INTO media_refresh_locks (
    cache_key,
    owner_id,
    lock_until_ms,
    updated_at_ms
  )
  VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT(cache_key) DO UPDATE SET
    owner_id = excluded.owner_id,
    lock_until_ms = excluded.lock_until_ms,
    updated_at_ms = excluded.updated_at_ms
  WHERE media_refresh_locks.lock_until_ms < ?5
`;
const RELEASE_MEDIA_REFRESH_LOCK_SQL = `
  DELETE FROM media_refresh_locks
  WHERE cache_key = ?1
    AND owner_id = ?2
`;
const PURGE_OLD_MEDIA_CACHE_SQL = `
  DELETE FROM media_cache_entries
  WHERE stale_until_ms > 0
    AND stale_until_ms < ?1
`;
const PURGE_OLD_MEDIA_LOCKS_SQL = `
  DELETE FROM media_refresh_locks
  WHERE lock_until_ms > 0
    AND lock_until_ms < ?1
`;
const LIST_SYNC_KEYS = new Set([
  'bilm-favorites',
  'bilm-watch-later',
  'bilm-continue-watching',
  'bilm-watch-history',
  'bilm-search-history',
  'bilm-shared-chat',
  'bilm-history-movies',
  'bilm-history-tv'
]);
const SECTOR_SYNC_KEYS = new Set([
  'favorites',
  'watch_later',
  'continue_watching',
  'watch_history',
  'search_history',
  'chat_messages',
  'settings_profile',
  'playback_notes',
  'tv_progress',
  'ui_prefs'
]);
const CHAT_SECTOR_KEY = 'chat_messages';
const SETTINGS_PROFILE_SECTOR_KEY = 'settings_profile';
const PLAYBACK_NOTES_SECTOR_KEY = 'playback_notes';
const TV_PROGRESS_SECTOR_KEY = 'tv_progress';
const UI_PREFS_SECTOR_KEY = 'ui_prefs';
const TOMBSTONE_RETENTION_DAYS = 30;
const MEDIA_CACHE_R2_INLINE_THRESHOLD_BYTES = 96 * 1024;
const MEDIA_REFRESH_LOCK_MS = 30 * 1000;
const MEDIA_CACHE_PROFILE_MS = Object.freeze({
  search: { freshMs: 15 * 60 * 1000, staleMs: 24 * 60 * 60 * 1000 },
  discovery: { freshMs: 2 * 60 * 60 * 1000, staleMs: 24 * 60 * 60 * 1000 },
  details: { freshMs: 24 * 60 * 60 * 1000, staleMs: 7 * 24 * 60 * 60 * 1000 },
  metadata: { freshMs: 7 * 24 * 60 * 60 * 1000, staleMs: 30 * 24 * 60 * 60 * 1000 },
  error: { freshMs: 5 * 60 * 1000, staleMs: 60 * 60 * 1000 }
});
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
  'https://data-api.reidmhit.workers.dev',
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

function getR2Bucket(env) {
  const bucket = env?.BILM_R2;
  return bucket && typeof bucket.get === 'function' && typeof bucket.put === 'function'
    ? bucket
    : null;
}

function isAuthTemporarilyDisabled(env, request = null) {
  const envFlag = String(env?.BILM_DISABLE_AUTH || '').trim().toLowerCase();
  const envEnabled = envFlag === '1' || envFlag === 'true' || envFlag === 'yes' || envFlag === 'on';
  if (envEnabled) return true;
  const headerValue = String(request?.headers?.get?.('x-bilm-auth-bypass') || '').trim().toLowerCase();
  return headerValue === '1' || headerValue === 'true' || headerValue === 'yes';
}

function normalizeUserId(value) {
  return String(value || '').trim().replace(/^user-/i, '');
}

function isValidUserId(userId) {
  const normalized = normalizeUserId(userId);
  return normalized.length >= 25 && normalized.length <= 30;
}

function normalizeListKey(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidListKey(value) {
  const key = normalizeListKey(value);
  return LIST_SYNC_KEYS.has(key);
}

function normalizeSectorKey(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidSectorKey(value) {
  const key = normalizeSectorKey(value);
  return SECTOR_SYNC_KEYS.has(key);
}

function normalizeItemKey(value) {
  return String(value || '').trim();
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

function createRequestId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    // no-op
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function errorResponse(status, {
  error,
  message,
  retryable = false,
  code = null,
  requestId = null
}, corsOrigin = '', extraHeaders = {}) {
  const payload = {
    error: String(error || 'internal_error'),
    message: String(message || 'Unexpected server error.'),
    retryable: Boolean(retryable),
    code: String(code || error || 'internal_error'),
    requestId: requestId || createRequestId()
  };
  const logger = Number(status || 0) >= 500 ? console.error : console.warn;
  logger(`[api][${payload.requestId}] ${payload.code}: ${payload.message}`, {
    status: Number(status || 0) || 0,
    retryable: payload.retryable
  });
  return jsonResponse(status, payload, corsOrigin, {
    'x-request-id': payload.requestId,
    ...extraHeaders
  });
}

async function parseJsonBody(request, corsOrigin, requestId = null) {
  try {
    return await request.json();
  } catch {
    throw errorResponse(400, {
      error: 'invalid_json',
      message: 'Request body must be valid JSON.',
      retryable: false,
      code: 'invalid_json',
      requestId
    }, corsOrigin);
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
    return {
      error: 'token_expired',
      message: 'Firebase token has expired.',
      retryable: true,
      code: 'token_expired'
    };
  }
  return {
    error: 'invalid_token',
    message: 'Firebase token verification failed.',
    retryable: false,
    code: 'invalid_token'
  };
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

async function requireSnapshotAuth({ request, corsOrigin, env, verifyIdToken, userId, requestId = null }) {
  if (isAuthTemporarilyDisabled(env, request)) {
    const normalizedUserId = normalizeUserId(userId);
    console.warn(`[api][${requestId || 'no-request-id'}] auth bypass enabled for user ${normalizedUserId || 'unknown'}`);
    return { sub: normalizedUserId, authBypassed: true };
  }

  const token = getBearerToken(request);
  if (!token) {
    throw errorResponse(401, {
      error: 'missing_token',
      message: 'Authorization Bearer token is required.',
      retryable: false,
      code: 'missing_token',
      requestId
    }, corsOrigin);
  }

  let payload;
  try {
    payload = await verifyIdToken(token, { projectId: getProjectId(env) });
  } catch (error) {
    const detail = classifyAuthFailure(error);
    throw errorResponse(401, { ...detail, requestId }, corsOrigin);
  }

  const subject = String(payload?.sub || '').trim();
  const normalizedUserId = normalizeUserId(userId);
  if (!subject || subject !== normalizedUserId) {
    throw errorResponse(403, {
      error: 'forbidden',
      message: 'Token subject does not match requested userId.',
      retryable: false,
      code: 'forbidden',
      requestId
    }, corsOrigin);
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

function assertD1Configured(env, corsOrigin) {
  if (!getD1Database(env)) {
    throw jsonResponse(503, {
      error: 'd1_not_configured',
      message: 'BILM_DB (D1) is required for sync endpoints.'
    }, corsOrigin);
  }
}

function assertMediaCacheConfigured(env, corsOrigin) {
  if (!getD1Database(env)) {
    throw errorResponse(503, {
      error: 'media_cache_not_configured',
      message: 'BILM_DB (D1) is required for media cache endpoints.',
      retryable: false,
      code: 'media_cache_not_configured'
    }, corsOrigin);
  }
}

function getMediaSecret(env, key) {
  return String(env?.[key] || '').trim();
}

function normalizeQueryText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.slice(0, 180);
}

function classifyTmdbResourceType(pathname = '') {
  const path = String(pathname || '').toLowerCase();
  if (path.includes('/search/')) return 'search';
  if (
    path.includes('/discover/') ||
    path.includes('/trending/') ||
    path.includes('/recommendations') ||
    path.includes('/similar') ||
    path.includes('/popular') ||
    path.includes('/top_rated') ||
    path.includes('/upcoming') ||
    path.includes('/now_playing') ||
    path.includes('/on_the_air') ||
    path.includes('/airing_today')
  ) {
    return 'discovery';
  }
  if (path.includes('/genre/') || path.includes('/configuration')) return 'metadata';
  return 'details';
}

function classifyTvmazeResourceType(pathname = '') {
  const path = String(pathname || '').toLowerCase();
  if (path.startsWith('/search/')) return 'search';
  return 'details';
}

function classifyOmdbResourceType(searchParams) {
  const hasSearch = String(searchParams?.get?.('s') || '').trim().length > 0;
  if (hasSearch) return 'search';
  return 'details';
}

function classifyAniListResourceType(bodyPayload = null) {
  const queryText = String(bodyPayload?.query || '').toLowerCase();
  if (queryText.includes('search:')) return 'search';
  return 'details';
}

function getMediaCacheProfile(resourceType, statusCode = 200) {
  if (Number(statusCode || 0) >= 400) {
    return MEDIA_CACHE_PROFILE_MS.error;
  }
  return MEDIA_CACHE_PROFILE_MS[resourceType] || MEDIA_CACHE_PROFILE_MS.details;
}

function canonicalizeSearchParams(searchParams, excludedKeys = []) {
  const excluded = new Set((Array.isArray(excludedKeys) ? excludedKeys : [])
    .map((key) => String(key || '').trim().toLowerCase())
    .filter(Boolean));
  const pairs = [];
  for (const [key, value] of searchParams.entries()) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) continue;
    if (excluded.has(normalizedKey.toLowerCase())) continue;
    pairs.push([normalizedKey, String(value || '')]);
  }
  pairs.sort((a, b) => {
    if (a[0] === b[0]) return a[1].localeCompare(b[1]);
    return a[0].localeCompare(b[0]);
  });
  const normalized = new URLSearchParams();
  pairs.forEach(([key, value]) => normalized.append(key, value));
  return normalized.toString();
}

function fallbackHash(input = '') {
  const normalized = String(input || '');
  let hash = 5381;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) + hash) ^ normalized.charCodeAt(index);
  }
  return Math.abs(hash >>> 0).toString(16).padStart(8, '0');
}

async function sha256Hex(input = '') {
  try {
    const payload = new TextEncoder().encode(String(input || ''));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', payload);
    const bytes = new Uint8Array(digest);
    return [...bytes]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return fallbackHash(input);
  }
}

async function buildMediaCacheKey({
  provider,
  method = 'GET',
  pathname = '',
  searchParams,
  excludedQueryKeys = [],
  bodyText = ''
}) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedMethod = String(method || 'GET').trim().toUpperCase();
  const normalizedPath = String(pathname || '').trim().toLowerCase();
  const normalizedQuery = canonicalizeSearchParams(searchParams, excludedQueryKeys);
  const requestCore = `${normalizedProvider}:${normalizedMethod}:${normalizedPath}?${normalizedQuery}`;
  if (normalizedMethod === 'GET') return requestCore;
  const bodyHash = await sha256Hex(bodyText);
  return `${requestCore}:body:${bodyHash}`;
}

async function buildMediaPayloadR2Key(provider, cacheKey) {
  const hash = await sha256Hex(cacheKey);
  return `media-cache/${String(provider || 'misc').trim().toLowerCase()}/${hash}.json`;
}

function calculatePayloadBytes(text = '') {
  try {
    return new TextEncoder().encode(String(text || '')).byteLength;
  } catch {
    return String(text || '').length;
  }
}

function shouldStoreMediaPayloadInR2(payloadText = '') {
  return calculatePayloadBytes(payloadText) > MEDIA_CACHE_R2_INLINE_THRESHOLD_BYTES;
}

function normalizeMediaCacheRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    cacheKey: String(row.cache_key || '').trim(),
    provider: String(row.provider || '').trim(),
    resourceType: String(row.resource_type || '').trim() || 'details',
    statusCode: Number(row.status_code || 0) || 200,
    contentType: String(row.content_type || '').trim() || 'application/json; charset=utf-8',
    payloadInlineJson: typeof row.payload_inline_json === 'string' ? row.payload_inline_json : null,
    payloadR2Key: String(row.payload_r2_key || '').trim() || null,
    fetchedAtMs: Number(row.fetched_at_ms || 0) || 0,
    expiresAtMs: Number(row.expires_at_ms || 0) || 0,
    staleUntilMs: Number(row.stale_until_ms || 0) || 0,
    hitCount: Number(row.hit_count || 0) || 0,
    lastHitAtMs: Number(row.last_hit_at_ms || 0) || null
  };
}

async function readMediaCacheEntry({ db, cacheKey }) {
  if (!db) return null;
  const row = await db.prepare(SELECT_MEDIA_CACHE_ENTRY_SQL).bind(cacheKey).first();
  return normalizeMediaCacheRow(row);
}

async function touchMediaCacheEntry({ db, cacheKey }) {
  if (!db || !cacheKey) return;
  try {
    await db.prepare(TOUCH_MEDIA_CACHE_ENTRY_SQL).bind(cacheKey, Date.now()).run();
  } catch (error) {
    console.warn('media cache touch failed:', error);
  }
}

async function trackMediaQueryMetric({ db, provider, resourceType, queryText }) {
  if (!db) return;
  const normalized = normalizeQueryText(queryText);
  if (!normalized) return;
  try {
    await db
      .prepare(UPSERT_MEDIA_QUERY_METRIC_SQL)
      .bind(
        String(provider || '').trim().toLowerCase(),
        String(resourceType || '').trim().toLowerCase() || 'details',
        normalized,
        Date.now()
      )
      .run();
  } catch (error) {
    console.warn('media query metric upsert failed:', error);
  }
}

async function readMediaPayloadFromStorage({ env, entry }) {
  if (!entry) return null;
  if (typeof entry.payloadInlineJson === 'string' && entry.payloadInlineJson.length > 0) {
    return entry.payloadInlineJson;
  }
  if (!entry.payloadR2Key) return null;

  const bucket = getR2Bucket(env);
  if (!bucket) return null;

  try {
    const object = await bucket.get(entry.payloadR2Key);
    if (!object) return null;
    if (typeof object.text === 'function') {
      return await object.text();
    }
    if (typeof object.arrayBuffer === 'function') {
      const arrayBuffer = await object.arrayBuffer();
      return new TextDecoder().decode(arrayBuffer);
    }
  } catch (error) {
    console.warn('media cache R2 read failed:', error);
  }
  return null;
}

async function persistMediaCacheEntry({
  env,
  db,
  cacheKey,
  provider,
  resourceType,
  queryText = '',
  statusCode = 200,
  contentType = 'application/json; charset=utf-8',
  payloadText = '',
  fetchedAtMs = Date.now(),
  expiresAtMs = Date.now(),
  staleUntilMs = Date.now()
}) {
  const bucket = getR2Bucket(env);
  let payloadInlineJson = String(payloadText || '');
  let payloadR2Key = null;

  if (bucket && shouldStoreMediaPayloadInR2(payloadInlineJson)) {
    try {
      payloadR2Key = await buildMediaPayloadR2Key(provider, cacheKey);
      await bucket.put(payloadR2Key, payloadInlineJson, {
        httpMetadata: { contentType: String(contentType || 'application/json; charset=utf-8') }
      });
      payloadInlineJson = null;
    } catch (error) {
      payloadR2Key = null;
      payloadInlineJson = String(payloadText || '');
      console.warn('media cache R2 write failed; falling back to D1 inline payload:', error);
    }
  }

  await db
    .prepare(UPSERT_MEDIA_CACHE_ENTRY_SQL)
    .bind(
      cacheKey,
      String(provider || '').trim().toLowerCase(),
      String(resourceType || '').trim().toLowerCase() || 'details',
      normalizeQueryText(queryText) || null,
      Number(statusCode || 200) || 200,
      String(contentType || 'application/json; charset=utf-8'),
      payloadInlineJson,
      payloadR2Key,
      Number(fetchedAtMs || Date.now()) || Date.now(),
      Number(expiresAtMs || Date.now()) || Date.now(),
      Number(staleUntilMs || Date.now()) || Date.now(),
      1,
      Date.now()
    )
    .run();
}

function createMediaResponse({
  statusCode = 200,
  contentType = 'application/json; charset=utf-8',
  payloadText = '',
  corsOrigin = '',
  cacheStatus = 'miss',
  stale = false,
  fetchedAtMs = null,
  expiresAtMs = null,
  staleUntilMs = null,
  requestId = null
}) {
  return new Response(String(payloadText || ''), {
    status: Number(statusCode || 200) || 200,
    headers: {
      'content-type': String(contentType || 'application/json; charset=utf-8'),
      'cache-control': 'public, max-age=60, stale-while-revalidate=300',
      ...createCorsHeaders(corsOrigin),
      'x-bilm-cache': String(cacheStatus || 'miss'),
      'x-bilm-stale': stale ? '1' : '0',
      'x-bilm-fetched-at-ms': fetchedAtMs ? String(Number(fetchedAtMs || 0) || 0) : '',
      'x-bilm-expires-at-ms': expiresAtMs ? String(Number(expiresAtMs || 0) || 0) : '',
      'x-bilm-stale-until-ms': staleUntilMs ? String(Number(staleUntilMs || 0) || 0) : '',
      ...(requestId ? { 'x-request-id': requestId } : {})
    }
  });
}

async function fetchMediaUpstream({
  url,
  method = 'GET',
  bodyText = '',
  headers = {}
}) {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 12000);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : bodyText,
      signal: abortController.signal
    });
    const payloadText = await response.text();
    return {
      ok: response.ok,
      statusCode: response.status,
      contentType: String(response.headers.get('content-type') || 'application/json; charset=utf-8'),
      payloadText
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function scheduleBackgroundTask(ctx, promise, label = 'background task') {
  if (!promise || typeof promise.then !== 'function') return;
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promise);
    return;
  }
  promise.catch((error) => {
    console.error(`${label} failed:`, error);
  });
}

async function acquireMediaRefreshLock({ db, cacheKey, requestId }) {
  const ownerId = `${requestId || createRequestId()}:${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const lockUntilMs = now + MEDIA_REFRESH_LOCK_MS;
  const result = await db
    .prepare(ACQUIRE_MEDIA_REFRESH_LOCK_SQL)
    .bind(cacheKey, ownerId, lockUntilMs, now, now)
    .run();
  const changed = Number(result?.meta?.changes || 0) || 0;
  if (changed <= 0) {
    return { acquired: false, ownerId: null };
  }
  return { acquired: true, ownerId };
}

async function releaseMediaRefreshLock({ db, cacheKey, ownerId }) {
  if (!ownerId) return;
  try {
    await db.prepare(RELEASE_MEDIA_REFRESH_LOCK_SQL).bind(cacheKey, ownerId).run();
  } catch (error) {
    console.warn('media refresh lock release failed:', error);
  }
}

async function refreshMediaCacheInBackground({
  env,
  db,
  requestId,
  cacheKey,
  provider,
  resourceType,
  queryText,
  upstreamUrl,
  method = 'GET',
  bodyText = '',
  upstreamHeaders = {}
}) {
  const { acquired, ownerId } = await acquireMediaRefreshLock({ db, cacheKey, requestId });
  if (!acquired) return;

  try {
    const upstream = await fetchMediaUpstream({
      url: upstreamUrl,
      method,
      bodyText,
      headers: upstreamHeaders
    });
    if (Number(upstream.statusCode || 0) >= 500) {
      return;
    }
    const profile = getMediaCacheProfile(resourceType, upstream.statusCode);
    const fetchedAtMs = Date.now();
    await persistMediaCacheEntry({
      env,
      db,
      cacheKey,
      provider,
      resourceType,
      queryText,
      statusCode: upstream.statusCode,
      contentType: upstream.contentType,
      payloadText: upstream.payloadText,
      fetchedAtMs,
      expiresAtMs: fetchedAtMs + profile.freshMs,
      staleUntilMs: fetchedAtMs + profile.freshMs + profile.staleMs
    });
  } catch (error) {
    console.warn('media cache background refresh failed:', error);
  } finally {
    await releaseMediaRefreshLock({ db, cacheKey, ownerId });
  }
}

async function handleCachedMediaUpstream({
  env,
  corsOrigin,
  requestId,
  ctx = null,
  provider,
  resourceType,
  queryText = '',
  cacheKey,
  upstreamUrl,
  method = 'GET',
  bodyText = '',
  upstreamHeaders = {}
}) {
  assertMediaCacheConfigured(env, corsOrigin);
  const db = getD1Database(env);
  const now = Date.now();

  const cachedEntry = await readMediaCacheEntry({ db, cacheKey });
  let cachedPayloadText = null;
  if (cachedEntry) {
    cachedPayloadText = await readMediaPayloadFromStorage({ env, entry: cachedEntry });
    await touchMediaCacheEntry({ db, cacheKey });
  }

  if (cachedEntry && typeof cachedPayloadText === 'string') {
    const fresh = now <= Number(cachedEntry.expiresAtMs || 0);
    const staleEligible = now <= Number(cachedEntry.staleUntilMs || 0);
    if (fresh) {
      await trackMediaQueryMetric({ db, provider, resourceType, queryText });
      return createMediaResponse({
        statusCode: cachedEntry.statusCode,
        contentType: cachedEntry.contentType,
        payloadText: cachedPayloadText,
        corsOrigin,
        cacheStatus: 'hit',
        stale: false,
        fetchedAtMs: cachedEntry.fetchedAtMs,
        expiresAtMs: cachedEntry.expiresAtMs,
        staleUntilMs: cachedEntry.staleUntilMs,
        requestId
      });
    }

    if (staleEligible) {
      const refreshPromise = refreshMediaCacheInBackground({
        env,
        db,
        requestId,
        cacheKey,
        provider,
        resourceType,
        queryText,
        upstreamUrl,
        method,
        bodyText,
        upstreamHeaders
      });
      scheduleBackgroundTask(ctx, refreshPromise, 'media cache refresh');

      await trackMediaQueryMetric({ db, provider, resourceType, queryText });
      return createMediaResponse({
        statusCode: cachedEntry.statusCode,
        contentType: cachedEntry.contentType,
        payloadText: cachedPayloadText,
        corsOrigin,
        cacheStatus: 'stale',
        stale: true,
        fetchedAtMs: cachedEntry.fetchedAtMs,
        expiresAtMs: cachedEntry.expiresAtMs,
        staleUntilMs: cachedEntry.staleUntilMs,
        requestId
      });
    }
  }

  try {
    const upstream = await fetchMediaUpstream({
      url: upstreamUrl,
      method,
      bodyText,
      headers: upstreamHeaders
    });

    if (
      Number(upstream.statusCode || 0) >= 500 &&
      cachedEntry &&
      typeof cachedPayloadText === 'string' &&
      now <= Number(cachedEntry.staleUntilMs || 0)
    ) {
      return createMediaResponse({
        statusCode: cachedEntry.statusCode,
        contentType: cachedEntry.contentType,
        payloadText: cachedPayloadText,
        corsOrigin,
        cacheStatus: 'stale-fallback',
        stale: true,
        fetchedAtMs: cachedEntry.fetchedAtMs,
        expiresAtMs: cachedEntry.expiresAtMs,
        staleUntilMs: cachedEntry.staleUntilMs,
        requestId
      });
    }

    const profile = getMediaCacheProfile(resourceType, upstream.statusCode);
    const fetchedAtMs = Date.now();

    if (Number(upstream.statusCode || 0) < 500) {
      await persistMediaCacheEntry({
        env,
        db,
        cacheKey,
        provider,
        resourceType,
        queryText,
        statusCode: upstream.statusCode,
        contentType: upstream.contentType,
        payloadText: upstream.payloadText,
        fetchedAtMs,
        expiresAtMs: fetchedAtMs + profile.freshMs,
        staleUntilMs: fetchedAtMs + profile.freshMs + profile.staleMs
      });
    }
    await trackMediaQueryMetric({ db, provider, resourceType, queryText });

    return createMediaResponse({
      statusCode: upstream.statusCode,
      contentType: upstream.contentType,
      payloadText: upstream.payloadText,
      corsOrigin,
      cacheStatus: 'miss',
      stale: false,
      fetchedAtMs,
      expiresAtMs: fetchedAtMs + profile.freshMs,
      staleUntilMs: fetchedAtMs + profile.freshMs + profile.staleMs,
      requestId
    });
  } catch (error) {
    if (
      cachedEntry &&
      typeof cachedPayloadText === 'string' &&
      now <= Number(cachedEntry.staleUntilMs || 0)
    ) {
      return createMediaResponse({
        statusCode: cachedEntry.statusCode,
        contentType: cachedEntry.contentType,
        payloadText: cachedPayloadText,
        corsOrigin,
        cacheStatus: 'stale-error',
        stale: true,
        fetchedAtMs: cachedEntry.fetchedAtMs,
        expiresAtMs: cachedEntry.expiresAtMs,
        staleUntilMs: cachedEntry.staleUntilMs,
        requestId
      });
    }
    if (error?.name === 'AbortError') {
      throw errorResponse(504, {
        error: 'upstream_timeout',
        message: `${provider.toUpperCase()} upstream timed out.`,
        retryable: true,
        code: `${provider}_timeout`,
        requestId
      }, corsOrigin);
    }
    throw errorResponse(502, {
      error: 'upstream_failure',
      message: `${provider.toUpperCase()} upstream request failed.`,
      retryable: true,
      code: `${provider}_upstream_failure`,
      requestId
    }, corsOrigin);
  }
}

async function handleMediaTmdbRequest({ request, env, corsOrigin, requestId, ctx = null }) {
  if (request.method !== 'GET') {
    return errorResponse(405, {
      error: 'method_not_allowed',
      message: 'TMDB proxy only supports GET.',
      retryable: false,
      code: 'method_not_allowed',
      requestId
    }, corsOrigin, {
      allow: 'GET, OPTIONS'
    });
  }

  const tmdbApiKey = getMediaSecret(env, 'TMDB_API_KEY');
  const tmdbReadAccessToken = getMediaSecret(env, 'TMDB_READ_ACCESS_TOKEN');
  if (!tmdbApiKey && !tmdbReadAccessToken) {
    return errorResponse(503, {
      error: 'tmdb_api_key_missing',
      message: 'TMDB credentials are not configured.',
      retryable: false,
      code: 'tmdb_api_key_missing',
      requestId
    }, corsOrigin);
  }

  const url = new URL(request.url);
  const pathSuffix = url.pathname.replace(/^\/media\/tmdb\/?/i, '').trim();
  if (!pathSuffix) {
    return errorResponse(400, {
      error: 'invalid_tmdb_path',
      message: 'TMDB proxy path is required.',
      retryable: false,
      code: 'invalid_tmdb_path',
      requestId
    }, corsOrigin);
  }

  const upstreamPath = `/3/${pathSuffix.replace(/^\/+/, '')}`;
  const upstreamUrl = new URL(`https://api.themoviedb.org${upstreamPath}`);
  for (const [key, value] of url.searchParams.entries()) {
    if (String(key || '').trim().toLowerCase() === 'api_key') continue;
    upstreamUrl.searchParams.append(key, value);
  }
  if (tmdbApiKey) {
    upstreamUrl.searchParams.set('api_key', tmdbApiKey);
  }

  const resourceType = classifyTmdbResourceType(upstreamPath);
  const queryText = normalizeQueryText(url.searchParams.get('query'));
  const cacheKey = await buildMediaCacheKey({
    provider: 'tmdb',
    method: 'GET',
    pathname: upstreamPath,
    searchParams: upstreamUrl.searchParams,
    excludedQueryKeys: ['api_key']
  });

  return handleCachedMediaUpstream({
    env,
    corsOrigin,
    requestId,
    ctx,
    provider: 'tmdb',
    resourceType,
    queryText,
    cacheKey,
    upstreamUrl: upstreamUrl.toString(),
    method: 'GET',
    upstreamHeaders: {
      accept: 'application/json',
      ...(tmdbReadAccessToken
        ? { authorization: `Bearer ${tmdbReadAccessToken}` }
        : {})
    }
  });
}

async function handleMediaTvmazeRequest({ request, env, corsOrigin, requestId, ctx = null }) {
  if (request.method !== 'GET') {
    return errorResponse(405, {
      error: 'method_not_allowed',
      message: 'TVmaze proxy only supports GET.',
      retryable: false,
      code: 'method_not_allowed',
      requestId
    }, corsOrigin, {
      allow: 'GET, OPTIONS'
    });
  }

  const url = new URL(request.url);
  const pathSuffix = url.pathname.replace(/^\/media\/tvmaze\/?/i, '').trim();
  if (!pathSuffix) {
    return errorResponse(400, {
      error: 'invalid_tvmaze_path',
      message: 'TVmaze proxy path is required.',
      retryable: false,
      code: 'invalid_tvmaze_path',
      requestId
    }, corsOrigin);
  }

  const upstreamPath = `/${pathSuffix.replace(/^\/+/, '')}`;
  const upstreamUrl = new URL(`https://api.tvmaze.com${upstreamPath}`);
  for (const [key, value] of url.searchParams.entries()) {
    upstreamUrl.searchParams.append(key, value);
  }

  const resourceType = classifyTvmazeResourceType(upstreamPath);
  const queryText = normalizeQueryText(url.searchParams.get('q'));
  const cacheKey = await buildMediaCacheKey({
    provider: 'tvmaze',
    method: 'GET',
    pathname: upstreamPath,
    searchParams: upstreamUrl.searchParams
  });

  return handleCachedMediaUpstream({
    env,
    corsOrigin,
    requestId,
    ctx,
    provider: 'tvmaze',
    resourceType,
    queryText,
    cacheKey,
    upstreamUrl: upstreamUrl.toString(),
    method: 'GET',
    upstreamHeaders: {
      accept: 'application/json'
    }
  });
}

async function handleMediaOmdbRequest({ request, env, corsOrigin, requestId, ctx = null }) {
  if (request.method !== 'GET') {
    return errorResponse(405, {
      error: 'method_not_allowed',
      message: 'OMDb proxy only supports GET.',
      retryable: false,
      code: 'method_not_allowed',
      requestId
    }, corsOrigin, {
      allow: 'GET, OPTIONS'
    });
  }

  const omdbApiKey = getMediaSecret(env, 'OMDB_API_KEY');
  if (!omdbApiKey) {
    return errorResponse(503, {
      error: 'omdb_api_key_missing',
      message: 'OMDB_API_KEY is not configured.',
      retryable: false,
      code: 'omdb_api_key_missing',
      requestId
    }, corsOrigin);
  }

  const url = new URL(request.url);
  const upstreamUrl = new URL('https://www.omdbapi.com/');
  for (const [key, value] of url.searchParams.entries()) {
    const normalizedKey = String(key || '').trim().toLowerCase();
    if (normalizedKey === 'apikey' || normalizedKey === 'api_key') continue;
    upstreamUrl.searchParams.append(key, value);
  }
  upstreamUrl.searchParams.set('apikey', omdbApiKey);

  const resourceType = classifyOmdbResourceType(url.searchParams);
  const queryText = normalizeQueryText(url.searchParams.get('s') || url.searchParams.get('t'));
  const cacheKey = await buildMediaCacheKey({
    provider: 'omdb',
    method: 'GET',
    pathname: '/query',
    searchParams: upstreamUrl.searchParams,
    excludedQueryKeys: ['apikey', 'api_key']
  });

  return handleCachedMediaUpstream({
    env,
    corsOrigin,
    requestId,
    ctx,
    provider: 'omdb',
    resourceType,
    queryText,
    cacheKey,
    upstreamUrl: upstreamUrl.toString(),
    method: 'GET',
    upstreamHeaders: {
      accept: 'application/json'
    }
  });
}

async function handleMediaAniListRequest({ request, env, corsOrigin, requestId, ctx = null }) {
  if (request.method !== 'POST') {
    return errorResponse(405, {
      error: 'method_not_allowed',
      message: 'AniList proxy only supports POST.',
      retryable: false,
      code: 'method_not_allowed',
      requestId
    }, corsOrigin, {
      allow: 'POST, OPTIONS'
    });
  }

  let bodyText = '';
  try {
    bodyText = await request.text();
  } catch {
    return errorResponse(400, {
      error: 'invalid_body',
      message: 'AniList request body is required.',
      retryable: false,
      code: 'invalid_body',
      requestId
    }, corsOrigin);
  }
  if (!String(bodyText || '').trim()) {
    return errorResponse(400, {
      error: 'invalid_body',
      message: 'AniList request body is required.',
      retryable: false,
      code: 'invalid_body',
      requestId
    }, corsOrigin);
  }

  let bodyPayload;
  try {
    bodyPayload = JSON.parse(bodyText);
  } catch {
    return errorResponse(400, {
      error: 'invalid_json',
      message: 'AniList body must be valid JSON.',
      retryable: false,
      code: 'invalid_json',
      requestId
    }, corsOrigin);
  }

  const resourceType = classifyAniListResourceType(bodyPayload);
  const queryText = normalizeQueryText(
    bodyPayload?.variables?.search ||
    bodyPayload?.variables?.query ||
    ''
  );
  const cacheKey = await buildMediaCacheKey({
    provider: 'anilist',
    method: 'POST',
    pathname: '/graphql',
    searchParams: new URLSearchParams(),
    bodyText
  });

  return handleCachedMediaUpstream({
    env,
    corsOrigin,
    requestId,
    ctx,
    provider: 'anilist',
    resourceType,
    queryText,
    cacheKey,
    upstreamUrl: 'https://graphql.anilist.co',
    method: 'POST',
    bodyText,
    upstreamHeaders: {
      'content-type': 'application/json',
      accept: 'application/json'
    }
  });
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

function normalizeUpdatedAtMs(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Date.now();
  }
  return Math.floor(parsed);
}

function normalizeListSyncOperation(rawOperation, corsOrigin, index = 0) {
  const listKey = normalizeListKey(rawOperation?.listKey);
  if (!isValidListKey(listKey)) {
    throw jsonResponse(400, {
      error: 'invalid_list_key',
      message: `Invalid listKey at operations[${index}].`
    }, corsOrigin);
  }

  const itemKey = normalizeItemKey(rawOperation?.itemKey);
  if (!itemKey || itemKey.length > 255) {
    throw jsonResponse(400, {
      error: 'invalid_item_key',
      message: `Invalid itemKey at operations[${index}].`
    }, corsOrigin);
  }

  const deleted = rawOperation?.deleted === true;
  const updatedAtMs = normalizeUpdatedAtMs(rawOperation?.updatedAtMs);
  const payloadCandidate = rawOperation?.payload ?? rawOperation?.item ?? rawOperation?.value ?? null;

  if (!deleted) {
    if (!payloadCandidate || typeof payloadCandidate !== 'object' || Array.isArray(payloadCandidate)) {
      throw jsonResponse(400, {
        error: 'invalid_payload',
        message: `Non-deleted operation requires object payload at operations[${index}].`
      }, corsOrigin);
    }
    assertNoCredentialStorage(payloadCandidate, corsOrigin);
  }

  return {
    listKey,
    itemKey,
    deleted,
    updatedAtMs,
    payload: deleted ? null : payloadCandidate
  };
}

function normalizeOperationId(value) {
  const opId = String(value || '').trim();
  if (!opId) return '';
  return opId.slice(0, 120);
}

function validateChatPayload(payload, { corsOrigin, index = 0, requestId = null }) {
  const text = String(payload?.text || '').trim();
  if (!text) {
    throw errorResponse(400, {
      error: 'invalid_payload',
      message: `Chat message text is required at operations[${index}].`,
      retryable: false,
      code: 'chat_payload_invalid',
      requestId
    }, corsOrigin);
  }
  if (text.length > 2000) {
    throw errorResponse(413, {
      error: 'payload_too_large',
      message: `Chat message exceeds 2000 characters at operations[${index}].`,
      retryable: false,
      code: 'chat_message_too_large',
      requestId
    }, corsOrigin);
  }
}

function validateGenericSectorPayload(payload, {
  corsOrigin,
  index = 0,
  requestId = null,
  sectorKey = ''
}) {
  const serialized = JSON.stringify(payload || {});
  const length = serialized.length;
  let maxLength = 12000;
  if (sectorKey === SETTINGS_PROFILE_SECTOR_KEY) maxLength = 16000;
  if (sectorKey === PLAYBACK_NOTES_SECTOR_KEY) maxLength = 24000;
  if (sectorKey === TV_PROGRESS_SECTOR_KEY) maxLength = 8000;
  if (sectorKey === UI_PREFS_SECTOR_KEY) maxLength = 6000;
  if (length > maxLength) {
    throw errorResponse(413, {
      error: 'payload_too_large',
      message: `Payload exceeds sector size limit at operations[${index}].`,
      retryable: false,
      code: 'sector_payload_too_large',
      requestId
    }, corsOrigin);
  }
}

function normalizeSectorSyncOperation(rawOperation, corsOrigin, index = 0, requestId = null) {
  const sectorKey = normalizeSectorKey(rawOperation?.sectorKey ?? rawOperation?.listKey);
  if (!isValidSectorKey(sectorKey)) {
    throw errorResponse(400, {
      error: 'invalid_sector_key',
      message: `Invalid sectorKey at operations[${index}].`,
      retryable: false,
      code: 'invalid_sector_key',
      requestId
    }, corsOrigin);
  }

  const itemKey = normalizeItemKey(rawOperation?.itemKey);
  if (!itemKey || itemKey.length > 255) {
    throw errorResponse(400, {
      error: 'invalid_item_key',
      message: `Invalid itemKey at operations[${index}].`,
      retryable: false,
      code: 'invalid_item_key',
      requestId
    }, corsOrigin);
  }

  const deleted = rawOperation?.deleted === true;
  const updatedAtMs = normalizeUpdatedAtMs(rawOperation?.updatedAtMs);
  const opId = normalizeOperationId(rawOperation?.opId || rawOperation?.operationId);
  const payloadCandidate = rawOperation?.payload ?? rawOperation?.item ?? rawOperation?.value ?? null;

  if (!deleted) {
    if (!payloadCandidate || typeof payloadCandidate !== 'object' || Array.isArray(payloadCandidate)) {
      throw errorResponse(400, {
        error: 'invalid_payload',
        message: `Non-deleted operation requires object payload at operations[${index}].`,
        retryable: false,
        code: sectorKey === CHAT_SECTOR_KEY ? 'chat_payload_invalid' : 'invalid_payload',
        requestId
      }, corsOrigin);
    }
    if (sectorKey === CHAT_SECTOR_KEY) {
      validateChatPayload(payloadCandidate, { corsOrigin, index, requestId });
    } else {
      validateGenericSectorPayload(payloadCandidate, { corsOrigin, index, requestId, sectorKey });
    }
    assertNoCredentialStorage(payloadCandidate, corsOrigin);
  }

  return {
    sectorKey,
    itemKey,
    deleted,
    updatedAtMs,
    opId: opId || null,
    payload: deleted ? null : payloadCandidate
  };
}

function parseSectorFilters(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return [];
  const tokens = raw
    .split(',')
    .map((token) => normalizeSectorKey(token))
    .filter(Boolean);
  return [...new Set(tokens)];
}

function buildSectorPullStatement({ db, userId, sinceMs, limit, sectors }) {
  const validSectors = Array.isArray(sectors) ? sectors.filter((sector) => isValidSectorKey(sector)) : [];
  const bindings = [userId, sinceMs];
  let sql = `${SELECT_SECTOR_SYNC_CHANGES_BASE_SQL}`;
  if (validSectors.length) {
    const placeholders = validSectors.map((_, index) => `?${index + 3}`).join(', ');
    sql += ` AND sector_key IN (${placeholders})`;
    bindings.push(...validSectors);
  }
  sql += ` ORDER BY updated_at_ms ASC LIMIT ?${bindings.length + 1}`;
  bindings.push(limit);
  return db.prepare(sql).bind(...bindings);
}

function formatSyncState(row) {
  if (!row) {
    return {
      migratedAtMs: null,
      migrationSource: null,
      updatedAtMs: null
    };
  }
  return {
    migratedAtMs: Number(row?.migrated_at_ms || 0) || null,
    migrationSource: String(row?.migration_source || '').trim() || null,
    updatedAtMs: Number(row?.updated_at_ms || 0) || null
  };
}

async function readUserSyncState({ db, userId }) {
  const row = await db.prepare(SELECT_USER_SYNC_STATE_SQL).bind(userId).first();
  return formatSyncState(row);
}

async function persistUserSyncState({
  db,
  userId,
  migratedAtMs,
  migrationSource = null,
  updatedAtMs = Date.now()
}) {
  const savedAt = new Date().toISOString();
  await db
    .prepare(UPSERT_USER_SYNC_STATE_SQL)
    .bind(
      userId,
      Number(migratedAtMs || 0) || null,
      String(migrationSource || '').trim() || null,
      Number(updatedAtMs || 0) || Date.now(),
      savedAt
    )
    .run();
}

function parseSinceMs(rawValue) {
  const value = Number(rawValue || 0);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function parsePullLimit(rawValue) {
  const value = Number(rawValue || 250);
  if (!Number.isFinite(value)) return 250;
  return Math.max(1, Math.min(500, Math.floor(value)));
}

async function handleListSyncPush({ request, env, corsOrigin, verifyIdToken }) {
  assertD1Configured(env, corsOrigin);
  const body = await parseJsonBody(request, corsOrigin);
  const userId = normalizeUserId(body?.userId);
  if (!isValidUserId(userId)) {
    return jsonResponse(400, { error: 'invalid_user_id', message: 'Invalid or missing userId.' }, corsOrigin);
  }

  await requireSnapshotAuth({ request, corsOrigin, env, verifyIdToken, userId });

  const operations = Array.isArray(body?.operations) ? body.operations : [];
  if (!operations.length) {
    return jsonResponse(200, { ok: true, processed: 0, cursorMs: parseSinceMs(body?.cursorMs) }, corsOrigin);
  }
  if (operations.length > 1000) {
    return jsonResponse(400, { error: 'too_many_operations', message: 'Maximum 1000 operations per request.' }, corsOrigin);
  }

  const db = getD1Database(env);
  const deviceId = String(body?.deviceId || '').trim() || null;
  const nowIso = new Date().toISOString();
  let cursorMs = parseSinceMs(body?.cursorMs);
  let processed = 0;

  for (let index = 0; index < operations.length; index += 1) {
    const operation = normalizeListSyncOperation(operations[index], corsOrigin, index);
    const itemJson = operation.deleted ? null : JSON.stringify(operation.payload);
    const deletedAtMs = operation.deleted ? operation.updatedAtMs : null;
    await db
      .prepare(UPSERT_LIST_SYNC_ITEM_SQL)
      .bind(
        userId,
        operation.listKey,
        operation.itemKey,
        itemJson,
        operation.updatedAtMs,
        deletedAtMs,
        deviceId,
        nowIso
      )
      .run();
    processed += 1;
    if (operation.updatedAtMs > cursorMs) {
      cursorMs = operation.updatedAtMs;
    }
  }

  return jsonResponse(200, { ok: true, processed, cursorMs }, corsOrigin);
}

async function handleListSyncPull({ request, env, corsOrigin, verifyIdToken }) {
  assertD1Configured(env, corsOrigin);
  const url = new URL(request.url);
  const userId = normalizeUserId(url.searchParams.get('userId'));
  if (!isValidUserId(userId)) {
    return jsonResponse(400, { error: 'invalid_user_id', message: 'Invalid or missing userId.' }, corsOrigin);
  }

  await requireSnapshotAuth({ request, corsOrigin, env, verifyIdToken, userId });

  const sinceMs = parseSinceMs(url.searchParams.get('since'));
  const limit = parsePullLimit(url.searchParams.get('limit'));
  const db = getD1Database(env);
  const query = await db.prepare(SELECT_LIST_SYNC_CHANGES_SQL).bind(userId, sinceMs, limit).all();
  const rows = Array.isArray(query?.results) ? query.results : [];

  let cursorMs = sinceMs;
  const operations = [];

  rows.forEach((row) => {
    const updatedAtMs = parseSinceMs(row?.updated_at_ms);
    if (updatedAtMs > cursorMs) {
      cursorMs = updatedAtMs;
    }
    const listKey = normalizeListKey(row?.list_key);
    const itemKey = normalizeItemKey(row?.item_key);
    if (!isValidListKey(listKey) || !itemKey) return;

    const deleted = Number(row?.deleted_at_ms || 0) > 0;
    if (deleted) {
      operations.push({
        listKey,
        itemKey,
        deleted: true,
        updatedAtMs
      });
      return;
    }

    let payload = null;
    try {
      payload = JSON.parse(String(row?.item_json || 'null'));
    } catch {
      payload = null;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;

    operations.push({
      listKey,
      itemKey,
      deleted: false,
      updatedAtMs,
      payload
    });
  });

  return jsonResponse(200, {
    ok: true,
    sinceMs,
    cursorMs,
    operations
  }, corsOrigin);
}

async function handleSectorSyncPush({ request, env, corsOrigin, verifyIdToken, requestId }) {
  assertD1Configured(env, corsOrigin);
  const body = await parseJsonBody(request, corsOrigin, requestId);
  const userId = normalizeUserId(body?.userId);
  if (!isValidUserId(userId)) {
    return errorResponse(400, {
      error: 'invalid_user_id',
      message: 'Invalid or missing userId.',
      retryable: false,
      code: 'invalid_user_id',
      requestId
    }, corsOrigin);
  }

  await requireSnapshotAuth({ request, corsOrigin, env, verifyIdToken, userId, requestId });

  const operations = Array.isArray(body?.operations) ? body.operations : [];
  if (!operations.length) {
    const state = await readUserSyncState({ db: getD1Database(env), userId });
    return jsonResponse(200, {
      ok: true,
      processed: 0,
      cursorMs: parseSinceMs(body?.cursorMs),
      rejected: [],
      state
    }, corsOrigin, { 'x-request-id': requestId });
  }
  if (operations.length > 1000) {
    return errorResponse(400, {
      error: 'too_many_operations',
      message: 'Maximum 1000 operations per request.',
      retryable: false,
      code: 'too_many_operations',
      requestId
    }, corsOrigin);
  }

  const chatOperationCount = operations.reduce((count, operation) => {
    const sector = normalizeSectorKey(operation?.sectorKey ?? operation?.listKey);
    return count + (sector === CHAT_SECTOR_KEY ? 1 : 0);
  }, 0);
  if (chatOperationCount > 250) {
    return errorResponse(429, {
      error: 'rate_limited',
      message: 'Too many chat operations in one request.',
      retryable: true,
      code: 'chat_rate_limited',
      requestId
    }, corsOrigin);
  }

  const db = getD1Database(env);
  const deviceId = String(body?.deviceId || '').trim() || null;
  const nowIso = new Date().toISOString();
  let cursorMs = parseSinceMs(body?.cursorMs);
  let processed = 0;

  for (let index = 0; index < operations.length; index += 1) {
    const operation = normalizeSectorSyncOperation(operations[index], corsOrigin, index, requestId);
    const itemJson = operation.deleted ? null : JSON.stringify(operation.payload);
    const deletedAtMs = operation.deleted ? operation.updatedAtMs : null;
    await db
      .prepare(UPSERT_SECTOR_SYNC_ITEM_SQL)
      .bind(
        userId,
        operation.sectorKey,
        operation.itemKey,
        itemJson,
        operation.updatedAtMs,
        deletedAtMs,
        deviceId,
        operation.opId,
        nowIso
      )
      .run();
    processed += 1;
    if (operation.updatedAtMs > cursorMs) {
      cursorMs = operation.updatedAtMs;
    }
  }

  const state = await readUserSyncState({ db, userId });
  return jsonResponse(200, {
    ok: true,
    processed,
    cursorMs,
    rejected: [],
    state
  }, corsOrigin, { 'x-request-id': requestId });
}

async function handleSectorSyncPull({ request, env, corsOrigin, verifyIdToken, requestId }) {
  assertD1Configured(env, corsOrigin);
  const url = new URL(request.url);
  const userId = normalizeUserId(url.searchParams.get('userId'));
  if (!isValidUserId(userId)) {
    return errorResponse(400, {
      error: 'invalid_user_id',
      message: 'Invalid or missing userId.',
      retryable: false,
      code: 'invalid_user_id',
      requestId
    }, corsOrigin);
  }

  await requireSnapshotAuth({ request, corsOrigin, env, verifyIdToken, userId, requestId });

  const sinceMs = parseSinceMs(url.searchParams.get('since'));
  const limit = parsePullLimit(url.searchParams.get('limit'));
  const requestedSectors = parseSectorFilters(url.searchParams.get('sectors'));
  const invalidSector = requestedSectors.find((sector) => !isValidSectorKey(sector));
  if (invalidSector) {
    return errorResponse(400, {
      error: 'invalid_sector_filter',
      message: `Invalid sector in "sectors" query: ${invalidSector}`,
      retryable: false,
      code: 'invalid_sector_filter',
      requestId
    }, corsOrigin);
  }

  const db = getD1Database(env);
  const query = await buildSectorPullStatement({
    db,
    userId,
    sinceMs,
    limit,
    sectors: requestedSectors
  }).all();
  const rows = Array.isArray(query?.results) ? query.results : [];

  let cursorMs = sinceMs;
  const operations = [];

  rows.forEach((row) => {
    const updatedAtMs = parseSinceMs(row?.updated_at_ms);
    if (updatedAtMs > cursorMs) cursorMs = updatedAtMs;
    const sectorKey = normalizeSectorKey(row?.sector_key);
    const itemKey = normalizeItemKey(row?.item_key);
    if (!isValidSectorKey(sectorKey) || !itemKey) return;

    const deleted = Number(row?.deleted_at_ms || 0) > 0;
    if (deleted) {
      operations.push({
        sectorKey,
        itemKey,
        deleted: true,
        updatedAtMs,
        opId: String(row?.op_id || '').trim() || null
      });
      return;
    }

    let payload = null;
    try {
      payload = JSON.parse(String(row?.item_json || 'null'));
    } catch {
      payload = null;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    operations.push({
      sectorKey,
      itemKey,
      deleted: false,
      updatedAtMs,
      opId: String(row?.op_id || '').trim() || null,
      payload
    });
  });

  const state = await readUserSyncState({ db, userId });
  return jsonResponse(200, {
    ok: true,
    sinceMs,
    cursorMs,
    operations,
    state
  }, corsOrigin, { 'x-request-id': requestId });
}

async function handleSectorSyncBootstrap({ request, env, corsOrigin, verifyIdToken, requestId }) {
  assertD1Configured(env, corsOrigin);
  const body = await parseJsonBody(request, corsOrigin, requestId);
  const userId = normalizeUserId(body?.userId);
  if (!isValidUserId(userId)) {
    return errorResponse(400, {
      error: 'invalid_user_id',
      message: 'Invalid or missing userId.',
      retryable: false,
      code: 'invalid_user_id',
      requestId
    }, corsOrigin);
  }

  await requireSnapshotAuth({ request, corsOrigin, env, verifyIdToken, userId, requestId });

  const db = getD1Database(env);
  const currentState = await readUserSyncState({ db, userId });
  if (currentState.migratedAtMs) {
    return jsonResponse(200, {
      ok: true,
      skipped: true,
      processed: 0,
      cursorMs: currentState.migratedAtMs,
      state: currentState
    }, corsOrigin, { 'x-request-id': requestId });
  }

  const operations = Array.isArray(body?.operations) ? body.operations : [];
  if (operations.length > 1000) {
    return errorResponse(400, {
      error: 'too_many_operations',
      message: 'Maximum 1000 operations per request.',
      retryable: false,
      code: 'too_many_operations',
      requestId
    }, corsOrigin);
  }

  const deviceId = String(body?.deviceId || '').trim() || null;
  const nowIso = new Date().toISOString();
  const migratedAtMs = Date.now();
  const migrationSource = String(body?.migrationSource || '').trim() || 'unknown';
  let cursorMs = parseSinceMs(body?.cursorMs);
  let processed = 0;

  for (let index = 0; index < operations.length; index += 1) {
    const operation = normalizeSectorSyncOperation(operations[index], corsOrigin, index, requestId);
    const itemJson = operation.deleted ? null : JSON.stringify(operation.payload);
    const deletedAtMs = operation.deleted ? operation.updatedAtMs : null;
    await db
      .prepare(UPSERT_SECTOR_SYNC_ITEM_SQL)
      .bind(
        userId,
        operation.sectorKey,
        operation.itemKey,
        itemJson,
        operation.updatedAtMs,
        deletedAtMs,
        deviceId,
        operation.opId,
        nowIso
      )
      .run();
    processed += 1;
    if (operation.updatedAtMs > cursorMs) {
      cursorMs = operation.updatedAtMs;
    }
  }

  await persistUserSyncState({
    db,
    userId,
    migratedAtMs,
    migrationSource,
    updatedAtMs: migratedAtMs
  });
  const state = await readUserSyncState({ db, userId });
  return jsonResponse(200, {
    ok: true,
    skipped: false,
    processed,
    cursorMs: Math.max(cursorMs, migratedAtMs),
    state
  }, corsOrigin, { 'x-request-id': requestId });
}

async function purgeExpiredTombstones({ env, retentionDays = TOMBSTONE_RETENTION_DAYS }) {
  const db = getD1Database(env);
  if (!db) {
    return { ok: false, purgedSectorItems: 0, purgedListItems: 0, cutoffMs: null };
  }

  const cutoffMs = Date.now() - (Math.max(1, Number(retentionDays || TOMBSTONE_RETENTION_DAYS)) * 24 * 60 * 60 * 1000);
  const sectorDeleteResult = await db.prepare(PURGE_OLD_SECTOR_TOMBSTONES_SQL).bind(cutoffMs).run();
  const listDeleteResult = await db.prepare(PURGE_OLD_LIST_TOMBSTONES_SQL).bind(cutoffMs).run();
  return {
    ok: true,
    cutoffMs,
    purgedSectorItems: Number(sectorDeleteResult?.meta?.changes || 0) || 0,
    purgedListItems: Number(listDeleteResult?.meta?.changes || 0) || 0
  };
}

async function purgeExpiredMediaCache({ env }) {
  const db = getD1Database(env);
  if (!db) {
    return { ok: false, purgedCacheEntries: 0, purgedLocks: 0, cutoffMs: null };
  }
  const cutoffMs = Date.now();
  const cacheDeleteResult = await db.prepare(PURGE_OLD_MEDIA_CACHE_SQL).bind(cutoffMs).run();
  const lockDeleteResult = await db.prepare(PURGE_OLD_MEDIA_LOCKS_SQL).bind(cutoffMs).run();
  return {
    ok: true,
    cutoffMs,
    purgedCacheEntries: Number(cacheDeleteResult?.meta?.changes || 0) || 0,
    purgedLocks: Number(lockDeleteResult?.meta?.changes || 0) || 0
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
      const requestId = createRequestId();

      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            ...createCorsHeaders(corsOrigin),
            allow: 'GET, POST, OPTIONS',
            'x-request-id': requestId
          }
        });
      }

      try {
        if (url.pathname.startsWith('/media/')) {
          return errorResponse(404, {
            error: 'route_not_found',
            message: 'Media routes are not available on data-api.',
            retryable: false,
            code: 'route_not_found',
            requestId
          }, corsOrigin);
        }

        if (request.method === 'POST' && url.pathname === '/sync/sectors/push') {
          return await handleSectorSyncPush({ request, env, corsOrigin, verifyIdToken, requestId });
        }

        if (request.method === 'GET' && url.pathname === '/sync/sectors/pull') {
          return await handleSectorSyncPull({ request, env, corsOrigin, verifyIdToken, requestId });
        }

        if (request.method === 'POST' && url.pathname === '/sync/sectors/bootstrap') {
          return await handleSectorSyncBootstrap({ request, env, corsOrigin, verifyIdToken, requestId });
        }

        if (request.method === 'POST' && url.pathname === '/sync/lists/push') {
          return await handleListSyncPush({ request, env, corsOrigin, verifyIdToken });
        }

        if (request.method === 'GET' && url.pathname === '/sync/lists/pull') {
          return await handleListSyncPull({ request, env, corsOrigin, verifyIdToken });
        }

        if (request.method === 'POST' && url.searchParams.get('import') === 'true') {
          return await handleImportRequest({ request, env, corsOrigin });
        }

        if (request.method === 'POST' && url.searchParams.get('bulk') === 'true') {
          return await handleBulkImportRequest({ request, env, corsOrigin });
        }

        if (request.method === 'POST' && url.pathname === '/sync/sectors/purge') {
          requireAdminToken({ request, corsOrigin, env });
          const result = await purgeExpiredTombstones({ env });
          return jsonResponse(200, {
            ok: true,
            ...result
          }, corsOrigin, { 'x-request-id': requestId });
        }

        if (request.method === 'GET') {
          return await handleGetSnapshot({ request, env, corsOrigin, verifyIdToken });
        }

        if (request.method === 'POST') {
          return await handleSaveSnapshot({ request, env, corsOrigin, verifyIdToken });
        }

        return errorResponse(405, {
          error: 'method_not_allowed',
          message: 'Method not allowed.',
          retryable: false,
          code: 'method_not_allowed',
          requestId
        }, corsOrigin, {
          allow: 'GET, POST, OPTIONS'
        });
      } catch (error) {
        if (error instanceof Response) return error;
        return errorResponse(500, {
          error: 'internal_error',
          message: 'Unexpected server error.',
          retryable: true,
          code: 'internal_error',
          requestId
        }, corsOrigin);
      }
    },
    async scheduled(_controller, env, _ctx) {
      try {
        await purgeExpiredTombstones({ env });
      } catch (error) {
        console.error('scheduled tombstone purge failed:', error);
      }
    }
  };
}

export default createWorker();

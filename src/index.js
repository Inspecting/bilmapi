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
const DELETE_SNAPSHOT_FOR_USER_SQL = `
  DELETE FROM user_snapshots
  WHERE user_id = ?1
`;
const DELETE_LIST_SYNC_ITEMS_FOR_USER_SQL = `
  DELETE FROM list_sync_items
  WHERE user_id = ?1
`;
const DELETE_SECTOR_SYNC_ITEMS_FOR_USER_SQL = `
  DELETE FROM sync_items
  WHERE user_id = ?1
`;
const DELETE_USER_SYNC_STATE_FOR_USER_SQL = `
  DELETE FROM user_sync_state
  WHERE user_id = ?1
`;
const DELETE_ACCOUNT_LINKS_FOR_USER_SQL = `
  DELETE FROM account_links
  WHERE requester_user_id = ?1
     OR target_user_id = ?1
     OR requester_email = ?2
     OR target_email = ?2
`;
const DELETE_ACCOUNT_USER_CAPABILITY_FOR_USER_SQL = `
  DELETE FROM account_user_capabilities
  WHERE user_id = ?1
     OR email = ?2
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
const UPSERT_ACCOUNT_USER_CAPABILITY_SQL = `
  INSERT INTO account_user_capabilities (
    user_id,
    email,
    chat_ready,
    last_chat_seen_at_ms,
    updated_at_ms
  )
  VALUES (?1, ?2, ?3, ?4, ?5)
  ON CONFLICT(user_id) DO UPDATE SET
    email = excluded.email,
    chat_ready = CASE
      WHEN excluded.chat_ready > account_user_capabilities.chat_ready THEN excluded.chat_ready
      ELSE account_user_capabilities.chat_ready
    END,
    last_chat_seen_at_ms = CASE
      WHEN excluded.last_chat_seen_at_ms IS NULL THEN account_user_capabilities.last_chat_seen_at_ms
      WHEN account_user_capabilities.last_chat_seen_at_ms IS NULL THEN excluded.last_chat_seen_at_ms
      WHEN excluded.last_chat_seen_at_ms > account_user_capabilities.last_chat_seen_at_ms THEN excluded.last_chat_seen_at_ms
      ELSE account_user_capabilities.last_chat_seen_at_ms
    END,
    updated_at_ms = excluded.updated_at_ms
`;
const SELECT_ACCOUNT_USER_CAPABILITY_BY_EMAIL_SQL = `
  SELECT user_id, email, chat_ready, last_chat_seen_at_ms, updated_at_ms
  FROM account_user_capabilities
  WHERE email = ?1
  ORDER BY updated_at_ms DESC
  LIMIT 1
`;
const INSERT_ACCOUNT_LINK_SQL = `
  INSERT INTO account_links (
    id,
    status,
    requester_user_id,
    requester_email,
    target_user_id,
    target_email,
    requester_share_scopes_json,
    target_share_scopes_json,
    requester_approved_at_ms,
    target_approved_at_ms,
    created_at_ms,
    updated_at_ms,
    activated_at_ms,
    declined_at_ms,
    unlinked_at_ms
  )
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
`;
const UPSERT_ACCOUNT_LINK_SQL = `
  INSERT INTO account_links (
    id,
    status,
    requester_user_id,
    requester_email,
    target_user_id,
    target_email,
    requester_share_scopes_json,
    target_share_scopes_json,
    requester_approved_at_ms,
    target_approved_at_ms,
    created_at_ms,
    updated_at_ms,
    activated_at_ms,
    declined_at_ms,
    unlinked_at_ms
  )
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
  ON CONFLICT(id) DO UPDATE SET
    status = excluded.status,
    requester_user_id = excluded.requester_user_id,
    requester_email = excluded.requester_email,
    target_user_id = excluded.target_user_id,
    target_email = excluded.target_email,
    requester_share_scopes_json = excluded.requester_share_scopes_json,
    target_share_scopes_json = excluded.target_share_scopes_json,
    requester_approved_at_ms = excluded.requester_approved_at_ms,
    target_approved_at_ms = excluded.target_approved_at_ms,
    created_at_ms = excluded.created_at_ms,
    updated_at_ms = excluded.updated_at_ms,
    activated_at_ms = excluded.activated_at_ms,
    declined_at_ms = excluded.declined_at_ms,
    unlinked_at_ms = excluded.unlinked_at_ms
`;
const SELECT_ACCOUNT_LINK_BY_ID_SQL = `
  SELECT
    id,
    status,
    requester_user_id,
    requester_email,
    target_user_id,
    target_email,
    requester_share_scopes_json,
    target_share_scopes_json,
    requester_approved_at_ms,
    target_approved_at_ms,
    created_at_ms,
    updated_at_ms,
    activated_at_ms,
    declined_at_ms,
    unlinked_at_ms
  FROM account_links
  WHERE id = ?1
  LIMIT 1
`;
const LIST_ACCOUNT_LINKS_FOR_USER_SQL = `
  SELECT
    id,
    status,
    requester_user_id,
    requester_email,
    target_user_id,
    target_email,
    requester_share_scopes_json,
    target_share_scopes_json,
    requester_approved_at_ms,
    target_approved_at_ms,
    created_at_ms,
    updated_at_ms,
    activated_at_ms,
    declined_at_ms,
    unlinked_at_ms
  FROM account_links
  WHERE requester_user_id = ?1
    OR target_user_id = ?1
    OR requester_email = ?2
    OR target_email = ?2
  ORDER BY updated_at_ms DESC
  LIMIT 50
`;
const SELECT_BLOCKING_ACCOUNT_LINK_SQL = `
  SELECT id, status, created_at_ms, updated_at_ms
  FROM account_links
  WHERE status IN ('pending', 'active')
    AND id != ?3
    AND (
      requester_user_id = ?1
      OR target_user_id = ?1
      OR requester_email = ?2
      OR target_email = ?2
    )
  LIMIT 1
`;
const SELECT_SHARED_SYNC_ITEMS_BASE_SQL = `
  SELECT
    sector_key,
    item_key,
    item_json,
    updated_at_ms,
    deleted_at_ms,
    op_id
  FROM sync_items
  WHERE user_id = ?1
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
const SYNC_FUTURE_TIME_WINDOW_MS = 10 * 60 * 1000;
const TOMBSTONE_RETENTION_DAYS = 30;
const SUPABASE_CANONICAL_DELETED_RETENTION_DAYS = 7;
const SUPABASE_SYNC_STATE_SCOPE = 'sync_state';
const SUPABASE_SYNC_STATE_GROUP = 'sync';
const SUPABASE_SYNC_STATE_KEY = 'state';
const MEDIA_CACHE_R2_INLINE_THRESHOLD_BYTES = 96 * 1024;
const MEDIA_REFRESH_LOCK_MS = 30 * 1000;
const MEDIA_CACHE_PROFILE_MS = Object.freeze({
  search: { freshMs: 15 * 60 * 1000, staleMs: 24 * 60 * 60 * 1000 },
  discovery: { freshMs: 2 * 60 * 60 * 1000, staleMs: 24 * 60 * 60 * 1000 },
  details: { freshMs: 24 * 60 * 60 * 1000, staleMs: 7 * 24 * 60 * 60 * 1000 },
  metadata: { freshMs: 7 * 24 * 60 * 60 * 1000, staleMs: 30 * 24 * 60 * 60 * 1000 },
  error: { freshMs: 5 * 60 * 1000, staleMs: 60 * 60 * 1000 }
});
const ACCOUNT_LINK_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ACCOUNT_LINK_RATE_LIMIT_STORE = new Map();
let nextAccountLinkRateLimitSweepAtMs = 0;
const ACCOUNT_LINK_RATE_LIMIT_STORE_SOFT_CAP = 5000;
const SUPABASE_MIRROR_RUNTIME = {
  attempted: 0,
  succeeded: 0,
  failed: 0,
  lastAttemptAtMs: 0,
  lastSuccessAtMs: 0,
  lastFailureAtMs: 0,
  lastFailureStatus: 0,
  lastError: '',
  lastProbeAtMs: 0,
  lastProbeStatus: 0,
  lastProbeOk: false,
  lastProbeError: ''
};
const SUPABASE_CANONICAL_RUNTIME = {
  attempted: 0,
  succeeded: 0,
  failed: 0,
  lastAttemptAtMs: 0,
  lastSuccessAtMs: 0,
  lastFailureAtMs: 0,
  lastFailureStatus: 0,
  lastError: '',
  purgeAttempted: 0,
  purgeSucceeded: 0,
  purgeFailed: 0,
  lastPurgeAtMs: 0,
  lastPurgeCutoffMs: 0,
  lastPurgeStatus: 0,
  lastPurgeError: ''
};
const DEFAULT_ACCOUNT_LINK_RATE_LIMITS = Object.freeze({
  read: Object.freeze({ limit: 120, windowMs: 60_000 }),
  mutation: Object.freeze({ limit: 30, windowMs: 60_000 })
});
const PRIVATE_ENDPOINT_RATE_LIMIT_STORE = new Map();
let nextPrivateEndpointRateLimitSweepAtMs = 0;
const PRIVATE_ENDPOINT_RATE_LIMIT_STORE_SOFT_CAP = 8000;
const DEFAULT_PRIVATE_ENDPOINT_RATE_LIMITS = Object.freeze({
  snapshotRead: Object.freeze({ limit: 120, windowMs: 60_000 }),
  snapshotWrite: Object.freeze({ limit: 50, windowMs: 60_000 }),
  syncRead: Object.freeze({ limit: 120, windowMs: 60_000 }),
  syncWrite: Object.freeze({ limit: 70, windowMs: 60_000 })
});
const SUPABASE_CANONICAL_READ_COOLDOWN_STORE = new Map();
let nextSupabaseCanonicalReadCooldownSweepAtMs = 0;
const SUPABASE_CANONICAL_READ_COOLDOWN_SOFT_CAP = 8000;
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
  'https://www.watchbilm.org',
  'https://bilm.fly.dev',
  'https://data-api.watchbilm.org',
  'https://data-api.reidmhit.workers.dev',
  'https://bilm-backend.reidmhit.workers.dev'
]);
const MAX_SNAPSHOT_BYTES = 1500000;
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
const API_SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-permitted-cross-domain-policies': 'none'
});
// Keep mirror payload limits above snapshot size so backup events are preserved in full.
const SUPABASE_MIRROR_MAX_JSON_BYTES = MAX_SNAPSHOT_BYTES + 256_000;
const SUPABASE_MIRROR_MAX_TEXT_CHARS = SUPABASE_MIRROR_MAX_JSON_BYTES + 128_000;
const ACCOUNT_LINK_STATUS_PENDING = 'pending';
const ACCOUNT_LINK_STATUS_ACTIVE = 'active';
const ACCOUNT_LINK_STATUS_DECLINED = 'declined';
const ACCOUNT_LINK_STATUS_UNLINKED = 'unlinked';
const ACCOUNT_LINK_STATUS_EXPIRED = 'expired';
const ACCOUNT_LINK_SCOPE_KEYS = Object.freeze([
  'continueWatching',
  'favorites',
  'watchLater',
  'watchHistory',
  'searchHistory'
]);
const ACCOUNT_LINK_SCOPE_TO_SECTORS = Object.freeze({
  continueWatching: ['continue_watching', 'tv_progress'],
  favorites: ['favorites'],
  watchLater: ['watch_later'],
  watchHistory: ['watch_history'],
  searchHistory: ['search_history']
});
const DEFAULT_ACCOUNT_LINK_SCOPES = Object.freeze({
  continueWatching: false,
  favorites: false,
  watchLater: false,
  watchHistory: false,
  searchHistory: false
});

const firebaseJwks = createRemoteJWKSet(new URL(FIREBASE_JWKS_URL));
let authBypassWarningLogged = false;

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

function parseBooleanFlag(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function secureCompareStrings(left, right) {
  const leftValue = String(left || '');
  const rightValue = String(right || '');
  if (!leftValue || leftValue.length !== rightValue.length) return false;
  let mismatch = 0;
  for (let index = 0; index < leftValue.length; index += 1) {
    mismatch |= leftValue.charCodeAt(index) ^ rightValue.charCodeAt(index);
  }
  return mismatch === 0;
}

function isAuthTemporarilyDisabled(env, request = null) {
  const envEnabled = parseBooleanFlag(env?.BILM_DISABLE_AUTH);
  if (!envEnabled) return false;

  const bypassToken = String(env?.BILM_AUTH_BYPASS_TOKEN || '').trim();
  if (!bypassToken) {
    if (!authBypassWarningLogged) {
      console.warn('BILM_DISABLE_AUTH was set but BILM_AUTH_BYPASS_TOKEN is missing. Auth bypass remains disabled.');
      authBypassWarningLogged = true;
    }
    return false;
  }

  if (!request) return false;
  const headerValue = String(request?.headers?.get?.('x-bilm-auth-bypass') || '').trim();
  if (!headerValue) return false;
  return secureCompareStrings(headerValue, bypassToken);
}

function normalizeUserId(value) {
  return String(value || '').trim().replace(/^user-/i, '');
}

function isValidUserId(userId) {
  const normalized = normalizeUserId(userId);
  return /^[a-zA-Z0-9]{25,30}$/.test(normalized);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function canonicalizeEmailForMatching(value) {
  const normalized = normalizeEmail(value);
  if (!normalized || !normalized.includes('@')) return normalized;
  const [localPartRaw, domainRaw] = normalized.split('@');
  const localPart = String(localPartRaw || '').trim();
  const domain = String(domainRaw || '').trim();
  if (!localPart || !domain) return normalized;

  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const plusIndex = localPart.indexOf('+');
    const baseLocal = (plusIndex >= 0 ? localPart.slice(0, plusIndex) : localPart).replace(/\./g, '');
    if (!baseLocal) return normalized;
    return `${baseLocal}@gmail.com`;
  }

  return normalized;
}

function getEmailMatchVariants(value) {
  const normalized = normalizeEmail(value);
  if (!normalized) return [];
  const variants = new Set([normalized]);
  const canonical = canonicalizeEmailForMatching(normalized);
  if (canonical) variants.add(canonical);
  return [...variants];
}

function emailsLikelySameAccount(left, right) {
  const leftVariants = new Set(getEmailMatchVariants(left));
  const rightVariants = getEmailMatchVariants(right);
  if (!leftVariants.size || !rightVariants.length) return false;
  return rightVariants.some((candidate) => leftVariants.has(candidate));
}

function isValidEmail(value) {
  const normalized = normalizeEmail(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

function normalizeAccountLinkScopes(rawScopes = {}) {
  const source = rawScopes && typeof rawScopes === 'object' && !Array.isArray(rawScopes)
    ? rawScopes
    : {};
  const normalized = { ...DEFAULT_ACCOUNT_LINK_SCOPES };
  ACCOUNT_LINK_SCOPE_KEYS.forEach((scopeKey) => {
    const snakeKey = scopeKey.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
    normalized[scopeKey] = source[scopeKey] === true || source[snakeKey] === true;
  });
  return normalized;
}

function parseAccountLinkScopesJson(rawValue) {
  if (!rawValue) return { ...DEFAULT_ACCOUNT_LINK_SCOPES };
  try {
    const parsed = JSON.parse(String(rawValue));
    return normalizeAccountLinkScopes(parsed);
  } catch {
    return { ...DEFAULT_ACCOUNT_LINK_SCOPES };
  }
}

function hasAnyEnabledAccountLinkScope(scopes = {}) {
  return ACCOUNT_LINK_SCOPE_KEYS.some((scopeKey) => scopes?.[scopeKey] === true);
}

function createAccountLinkId() {
  return `link-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function getAccountLinkRole(row, actorUserId = '', actorEmail = '') {
  const normalizedActorUserId = normalizeUserId(actorUserId);
  const normalizedActorEmail = normalizeEmail(actorEmail);
  const requesterUserId = normalizeUserId(row?.requester_user_id ?? row?.requesterUserId);
  const targetUserId = normalizeUserId(row?.target_user_id ?? row?.targetUserId);
  const requesterEmail = normalizeEmail(row?.requester_email ?? row?.requesterEmail);
  const targetEmail = normalizeEmail(row?.target_email ?? row?.targetEmail);

  const isRequester = (
    (normalizedActorUserId && requesterUserId === normalizedActorUserId)
    || (normalizedActorEmail && emailsLikelySameAccount(requesterEmail, normalizedActorEmail))
  );
  if (isRequester) return 'requester';

  const isTarget = (
    (normalizedActorUserId && targetUserId === normalizedActorUserId)
    || (normalizedActorEmail && emailsLikelySameAccount(targetEmail, normalizedActorEmail))
  );
  if (isTarget) return 'target';

  return '';
}

function isAccountLinkParticipant(row, actorUserId = '', actorEmail = '') {
  return Boolean(getAccountLinkRole(row, actorUserId, actorEmail));
}

function getEnabledSharedSectorsFromScopes(scopes = {}) {
  const sectors = new Set();
  ACCOUNT_LINK_SCOPE_KEYS.forEach((scopeKey) => {
    if (scopes?.[scopeKey] !== true) return;
    const mappedSectors = ACCOUNT_LINK_SCOPE_TO_SECTORS[scopeKey] || [];
    mappedSectors.forEach((sectorKey) => sectors.add(String(sectorKey || '').trim().toLowerCase()));
  });
  return [...sectors].filter((sectorKey) => isValidSectorKey(sectorKey));
}

function toOptionalTimestamp(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token, x-bilm-auth-bypass',
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
      ...API_SECURITY_HEADERS,
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
      ...API_SECURITY_HEADERS,
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

function createUuidV4() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    // no-op
  }
  try {
    if (globalThis.crypto?.getRandomValues) {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    }
  } catch {
    // no-op
  }
  const fallback = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  const part1 = fallback();
  const part2 = fallback().slice(0, 4);
  const part3 = `4${fallback().slice(1, 4)}`;
  const part4 = `${(8 + Math.floor(Math.random() * 4)).toString(16)}${fallback().slice(1, 4)}`;
  const part5 = `${fallback()}${fallback().slice(0, 4)}`;
  return `${part1}-${part2}-${part3}-${part4}-${part5}`;
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

function parseContentLengthHeader(request) {
  const rawValue = String(request?.headers?.get?.('content-length') || '').trim();
  if (!rawValue) return null;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

async function readRequestTextWithLimit(request, corsOrigin, requestId = null, maxBytes = MAX_JSON_BODY_BYTES) {
  const normalizedMaxBytes = Math.max(1, Number(maxBytes || MAX_JSON_BODY_BYTES) || MAX_JSON_BODY_BYTES);
  const declaredLength = parseContentLengthHeader(request);
  if (declaredLength !== null && declaredLength > normalizedMaxBytes) {
    throw errorResponse(413, {
      error: 'payload_too_large',
      message: `Request body exceeds maximum size of ${normalizedMaxBytes.toLocaleString()} bytes.`,
      retryable: false,
      code: 'payload_too_large',
      requestId
    }, corsOrigin, {
      'x-max-body-bytes': String(normalizedMaxBytes)
    });
  }

  if (!request?.body?.getReader) {
    const fallbackText = await request.text();
    const fallbackBytes = calculateJsonBytes(fallbackText);
    if (fallbackBytes > normalizedMaxBytes) {
      throw errorResponse(413, {
        error: 'payload_too_large',
        message: `Request body exceeds maximum size of ${normalizedMaxBytes.toLocaleString()} bytes.`,
        retryable: false,
        code: 'payload_too_large',
        requestId
      }, corsOrigin, {
        'x-max-body-bytes': String(normalizedMaxBytes)
      });
    }
    return fallbackText;
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += Number(value?.byteLength || 0);
      if (totalBytes > normalizedMaxBytes) {
        throw errorResponse(413, {
          error: 'payload_too_large',
          message: `Request body exceeds maximum size of ${normalizedMaxBytes.toLocaleString()} bytes.`,
          retryable: false,
          code: 'payload_too_large',
          requestId
        }, corsOrigin, {
          'x-max-body-bytes': String(normalizedMaxBytes)
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof Response) throw error;
    throw errorResponse(400, {
      error: 'invalid_body',
      message: 'Request body could not be read.',
      retryable: false,
      code: 'invalid_body',
      requestId
    }, corsOrigin);
  }
}

async function parseJsonBody(request, corsOrigin, requestId = null) {
  try {
    const bodyText = await readRequestTextWithLimit(request, corsOrigin, requestId);
    return JSON.parse(bodyText);
  } catch (error) {
    if (error instanceof Response) throw error;
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

function tryParseJson(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isSnapshotLikePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (String(value?.schema || '').trim() === 'bilm-backup-v1') return true;
  const hasStorageState = (
    (value.localStorage && typeof value.localStorage === 'object' && !Array.isArray(value.localStorage))
    || (value.sessionStorage && typeof value.sessionStorage === 'object' && !Array.isArray(value.sessionStorage))
  );
  const hasMeta = value.meta && typeof value.meta === 'object' && !Array.isArray(value.meta);
  return hasStorageState || hasMeta;
}

function extractSnapshotFromSaveBody(body = {}) {
  const queue = [body, body?.data, body?.snapshot, body?.export, body?.backup, body?.value];
  const seen = new Set();
  let inspected = 0;

  while (queue.length && inspected < 24) {
    inspected += 1;
    const candidate = queue.shift();
    if (!candidate) continue;

    if (typeof candidate === 'string') {
      const parsed = tryParseJson(candidate);
      if (parsed) queue.push(parsed);
      continue;
    }

    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;

    if (isSnapshotLikePayload(candidate)) {
      return String(candidate?.schema || '').trim()
        ? candidate
        : { ...candidate, schema: 'bilm-backup-v1' };
    }
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    queue.push(candidate.data, candidate.snapshot, candidate.export, candidate.backup, candidate.value);
  }

  return null;
}

function calculateJsonBytes(input) {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? null);
  return new TextEncoder().encode(String(text || '')).byteLength;
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

  await upsertAccountCapabilityFromAuthPayload({
    env,
    userId: normalizedUserId,
    payload,
    requestId
  });

  return payload;
}

async function requireAccountLinkAuthContext({
  request,
  env,
  corsOrigin,
  verifyIdToken,
  userId,
  requestId = null
}) {
  const normalizedUserId = normalizeUserId(userId);
  if (!isValidUserId(normalizedUserId)) {
    throw errorResponse(400, {
      error: 'invalid_user_id',
      message: 'Invalid or missing userId.',
      retryable: false,
      code: 'invalid_user_id',
      requestId
    }, corsOrigin);
  }

  const payload = await requireSnapshotAuth({
    request,
    corsOrigin,
    env,
    verifyIdToken,
    userId: normalizedUserId,
    requestId
  });
  const email = canonicalizeEmailForMatching(payload?.email || request?.headers?.get?.('x-bilm-auth-email'));
  if (!isValidEmail(email)) {
    throw errorResponse(403, {
      error: 'email_required',
      message: 'Token does not include a valid email address.',
      retryable: false,
      code: 'email_required',
      requestId
    }, corsOrigin);
  }
  return {
    userId: normalizedUserId,
    email,
    payload
  };
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
  const canonicalConfig = resolveSupabaseCanonicalConfig(env);
  if (isSupabaseCanonicalPrimaryActive(env, canonicalConfig)) {
    return;
  }
  if (!getD1Database(env) && !getKvNamespace(env)) {
    throw jsonResponse(503, {
      error: 'storage_not_configured',
      message: 'No storage backend is configured. Bind BILM_DB (D1) and/or BILM_DATA (KV), or enable SUPABASE_CANONICAL_PRIMARY with valid Supabase credentials.'
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

function parseEnvInt(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = String(env?.[name] ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function parseEnvBool(env, name, fallback = false) {
  const raw = String(env?.[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return fallback;
}

function normalizeSupabaseProjectUrl(rawValue = '') {
  const candidate = String(rawValue || '').trim();
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

function sanitizeMirrorUserId(value) {
  const normalized = normalizeUserId(value);
  if (!isValidUserId(normalized)) return null;
  return normalized;
}

function resolveSupabaseMirrorConfig(env) {
  const enabled = parseEnvBool(env, 'SUPABASE_MIRROR_ENABLED', true);
  const projectUrl = normalizeSupabaseProjectUrl(env?.SUPABASE_PROJECT_URL || env?.SUPABASE_URL || '');
  const serviceRoleKey = String(env?.SUPABASE_SERVICE_ROLE_KEY || env?.SUPABASE_SERVICE_KEY || '').trim();
  const table = String(env?.SUPABASE_MIRROR_TABLE || 'cloudflare_mirror_events').trim().toLowerCase();
  const timeoutMs = parseEnvInt(env, 'SUPABASE_MIRROR_TIMEOUT_MS', 10_000, { min: 1000, max: 60_000 });
  const maxRetries = parseEnvInt(env, 'SUPABASE_MIRROR_MAX_RETRIES', 2, { min: 0, max: 6 });
  const retryBaseMs = parseEnvInt(env, 'SUPABASE_MIRROR_RETRY_BASE_MS', 250, { min: 25, max: 5000 });
  const retryJitterMs = parseEnvInt(env, 'SUPABASE_MIRROR_RETRY_JITTER_MS', 100, { min: 0, max: 1500 });
  const validTable = /^[a-z0-9_.-]{1,128}$/i.test(table);
  return {
    enabled,
    active: enabled && Boolean(projectUrl && serviceRoleKey && validTable),
    projectUrl,
    serviceRoleKey,
    table: validTable ? table : 'cloudflare_mirror_events',
    timeoutMs,
    maxRetries,
    retryBaseMs,
    retryJitterMs
  };
}

function resolveSupabaseCanonicalConfig(env) {
  const enabled = parseEnvBool(env, 'SUPABASE_CANONICAL_ENABLED', true);
  const projectUrl = normalizeSupabaseProjectUrl(env?.SUPABASE_PROJECT_URL || env?.SUPABASE_URL || '');
  const serviceRoleKey = String(env?.SUPABASE_SERVICE_ROLE_KEY || env?.SUPABASE_SERVICE_KEY || '').trim();
  const profileTable = String(env?.SUPABASE_CANONICAL_PROFILE_TABLE || env?.SUPABASE_PROFILE_TABLE || 'bilm_profiles').trim().toLowerCase();
  const userDataTable = String(env?.SUPABASE_CANONICAL_USER_DATA_TABLE || env?.SUPABASE_USER_DATA_TABLE || 'bilm_user_data').trim().toLowerCase();
  const timeoutMs = parseEnvInt(env, 'SUPABASE_CANONICAL_TIMEOUT_MS', 10_000, { min: 1000, max: 60_000 });
  const maxRetries = parseEnvInt(env, 'SUPABASE_CANONICAL_MAX_RETRIES', 1, { min: 0, max: 6 });
  const retryBaseMs = parseEnvInt(env, 'SUPABASE_CANONICAL_RETRY_BASE_MS', 250, { min: 25, max: 5000 });
  const retryJitterMs = parseEnvInt(env, 'SUPABASE_CANONICAL_RETRY_JITTER_MS', 100, { min: 0, max: 1500 });
  const batchSize = parseEnvInt(env, 'SUPABASE_CANONICAL_BATCH_SIZE', 250, { min: 1, max: 1000 });
  const deletedRetentionDays = parseEnvInt(
    env,
    'SUPABASE_CANONICAL_DELETED_RETENTION_DAYS',
    SUPABASE_CANONICAL_DELETED_RETENTION_DAYS,
    { min: 1, max: 90 }
  );
  const validProfileTable = /^[a-z0-9_.-]{1,128}$/i.test(profileTable);
  const validUserDataTable = /^[a-z0-9_.-]{1,128}$/i.test(userDataTable);
  return {
    enabled,
    active: enabled && Boolean(projectUrl && serviceRoleKey && validProfileTable && validUserDataTable),
    projectUrl,
    serviceRoleKey,
    profileTable: validProfileTable ? profileTable : 'bilm_profiles',
    userDataTable: validUserDataTable ? userDataTable : 'bilm_user_data',
    timeoutMs,
    maxRetries,
    retryBaseMs,
    retryJitterMs,
    batchSize,
    deletedRetentionDays
  };
}

function isSupabaseCanonicalPrimaryActive(env, canonicalConfig = null) {
  const config = canonicalConfig || resolveSupabaseCanonicalConfig(env);
  const enabled = parseEnvBool(env, 'SUPABASE_CANONICAL_PRIMARY', false);
  return enabled && config.active;
}

function buildSupabaseMirrorUrl(config) {
  const url = new URL(`/rest/v1/${encodeURIComponent(config.table)}`, `${config.projectUrl}/`);
  url.searchParams.set('on_conflict', 'event_id');
  return url.toString();
}

function buildSupabaseMirrorProbeUrl(config) {
  const url = new URL(`/rest/v1/${encodeURIComponent(config.table)}`, `${config.projectUrl}/`);
  url.searchParams.set('select', 'event_id');
  url.searchParams.set('limit', '1');
  return url.toString();
}

function buildSupabaseTableUrl({ projectUrl = '', table = '', searchParams = null } = {}) {
  const url = new URL(`/rest/v1/${encodeURIComponent(String(table || '').trim())}`, `${String(projectUrl || '').trim()}/`);
  if (searchParams && typeof searchParams === 'object') {
    Object.entries(searchParams).forEach(([key, value]) => {
      if (value === null || typeof value === 'undefined' || value === '') return;
      if (Array.isArray(value)) {
        value.forEach((entry) => {
          if (entry === null || typeof entry === 'undefined' || entry === '') return;
          url.searchParams.append(key, String(entry));
        });
        return;
      }
      url.searchParams.set(key, String(value));
    });
  }
  return url.toString();
}

function toMirrorBodySummary(value) {
  if (value === null || typeof value === 'undefined') {
    return { json: null, text: null, bytes: 0 };
  }
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    const bytes = calculateJsonBytes(serialized);
    if (typeof value === 'object' && value && !Array.isArray(value) && bytes <= SUPABASE_MIRROR_MAX_JSON_BYTES) {
      return { json: value, text: null, bytes };
    }
    const parsed = bytes <= SUPABASE_MIRROR_MAX_JSON_BYTES
      ? safeParse(serialized, null)
      : null;
    if (parsed && typeof parsed === 'object' && bytes <= SUPABASE_MIRROR_MAX_JSON_BYTES) {
      return { json: parsed, text: null, bytes };
    }
    return {
      json: null,
      text: serialized.slice(0, SUPABASE_MIRROR_MAX_TEXT_CHARS),
      bytes
    };
  } catch {
    const fallbackText = String(value || '');
    return {
      json: null,
      text: fallbackText.slice(0, SUPABASE_MIRROR_MAX_TEXT_CHARS),
      bytes: calculateJsonBytes(fallbackText)
    };
  }
}

function shouldMirrorToSupabase(pathname = '', method = 'GET', status = 0) {
  const normalizedPath = String(pathname || '').trim();
  const normalizedMethod = String(method || 'GET').trim().toUpperCase();
  if (!(status >= 200 && status < 300)) return false;
  if (normalizedMethod !== 'POST') return false;
  if (normalizedPath === '/') return true;
  if (normalizedPath === '/account/reset') return true;
  if (normalizedPath.startsWith('/sync/lists/')) return true;
  if (normalizedPath.startsWith('/sync/sectors/')) return true;
  if (normalizedPath.startsWith('/links/')) return true;
  return false;
}

function shouldRetrySupabaseMirrorStatus(status = 0) {
  const normalizedStatus = Number(status || 0) || 0;
  if (normalizedStatus === 408) return true;
  if (normalizedStatus === 409) return true;
  if (normalizedStatus === 425) return true;
  if (normalizedStatus === 429) return true;
  if (normalizedStatus >= 500) return true;
  return false;
}

function computeSupabaseMirrorRetryDelayMs({
  attempt = 0,
  baseMs = 250,
  jitterMs = 0
} = {}) {
  const safeAttempt = Math.max(0, Number(attempt) || 0);
  const boundedAttempt = Math.min(safeAttempt, 6);
  const exponential = (Math.max(0, Number(baseMs) || 0)) * (2 ** boundedAttempt);
  const jitter = Math.max(0, Math.floor(Math.random() * (Math.max(0, Number(jitterMs) || 0))));
  return exponential + jitter;
}

async function waitForSupabaseMirrorRetry(delayMs = 0) {
  const safeDelayMs = Math.max(0, Number(delayMs) || 0);
  if (safeDelayMs <= 0) return;
  if (globalThis.scheduler && typeof globalThis.scheduler.wait === 'function') {
    try {
      await globalThis.scheduler.wait(safeDelayMs);
      return;
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, safeDelayMs));
}

function shouldWriteCanonicalSupabase(pathname = '', method = 'GET', status = 0) {
  const normalizedPath = String(pathname || '').trim();
  const normalizedMethod = String(method || 'GET').trim().toUpperCase();
  if (!(status >= 200 && status < 300)) return false;
  if (normalizedMethod !== 'POST') return false;
  if (normalizedPath === '/') return true;
  if (normalizedPath === '/sync/lists/push') return true;
  if (normalizedPath === '/sync/sectors/push') return true;
  if (normalizedPath === '/sync/sectors/bootstrap') return true;
  if (normalizedPath === '/account/reset') return true;
  return false;
}

function normalizeCanonicalPayloadObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function toCanonicalListOperation(rawOperation) {
  const listKey = normalizeListKey(rawOperation?.listKey);
  const itemKey = normalizeItemKey(rawOperation?.itemKey);
  if (!isValidListKey(listKey) || !itemKey || itemKey.length > 255) return null;
  const updatedAtMs = normalizeUpdatedAtMs(rawOperation?.updatedAtMs ?? rawOperation?.deletedAtMs ?? Date.now());
  const deleted = rawOperation?.deleted === true || Number(rawOperation?.deletedAtMs || 0) > 0;
  const payload = normalizeCanonicalPayloadObject(rawOperation?.payload ?? rawOperation?.item ?? rawOperation?.value ?? null);
  if (!deleted && !payload) return null;
  return {
    listKey,
    itemKey,
    updatedAtMs,
    deleted,
    payload: deleted ? null : payload
  };
}

function toCanonicalSectorOperation(rawOperation) {
  const sectorKey = normalizeSectorKey(rawOperation?.sectorKey ?? rawOperation?.listKey);
  const itemKey = normalizeItemKey(rawOperation?.itemKey);
  if (!isValidSectorKey(sectorKey) || !itemKey || itemKey.length > 255) return null;
  const updatedAtMs = normalizeUpdatedAtMs(rawOperation?.updatedAtMs ?? rawOperation?.deletedAtMs ?? Date.now());
  const deleted = rawOperation?.deleted === true || Number(rawOperation?.deletedAtMs || 0) > 0;
  const payload = normalizeCanonicalPayloadObject(rawOperation?.payload ?? rawOperation?.item ?? rawOperation?.value ?? null);
  const opId = normalizeOperationId(rawOperation?.opId || rawOperation?.operationId || '');
  if (!deleted && !payload) return null;
  return {
    sectorKey,
    itemKey,
    updatedAtMs,
    deleted,
    opId: opId || null,
    payload: deleted ? null : payload
  };
}

function createCanonicalProfileRow({
  userId = '',
  path = '',
  metadata = null,
  email = null
} = {}) {
  const nowIso = new Date().toISOString();
  const normalizedEmail = canonicalizeEmailForMatching(email || '');
  const row = {
    user_id: userId,
    source: 'data-api-worker',
    last_path: String(path || '').trim() || '/',
    last_seen_at: nowIso,
    updated_at: nowIso,
    metadata_json: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
  };
  if (isValidEmail(normalizedEmail)) {
    row.email = normalizedEmail;
  }
  return row;
}

function createCanonicalUserDataRow({
  userId = '',
  scope = '',
  group = '',
  key = '',
  payload = null,
  updatedAtMs = 0,
  deletedAtMs = null,
  sourcePath = '',
  requestId = '',
  opId = null
} = {}) {
  const requestEventId = String(requestId || '').trim();
  const sourceEventId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestEventId)
    ? requestEventId
    : createUuidV4();
  const normalizedScope = String(scope || '').trim() || 'unknown';
  const normalizedGroup = String(group || '').trim() || 'unknown';
  const normalizedKey = String(key || '').trim() || 'unknown';
  const normalizedPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const nowIso = new Date().toISOString();
  return {
    user_id: userId,
    // Keep legacy columns populated for backward-compatible Supabase schemas.
    sector_key: normalizedGroup,
    item_key: normalizedKey,
    item_json: normalizedPayload,
    source_event_id: sourceEventId,
    occurred_at: nowIso,
    data_scope: normalizedScope,
    data_group: normalizedGroup,
    data_key: normalizedKey,
    op_id: opId ? String(opId).slice(0, 120) : null,
    payload_json: normalizedPayload,
    updated_at_ms: normalizeUpdatedAtMs(updatedAtMs || Date.now()),
    deleted_at_ms: deletedAtMs === null || typeof deletedAtMs === 'undefined'
      ? null
      : normalizeUpdatedAtMs(deletedAtMs || Date.now()),
    source_path: String(sourcePath || '').trim() || '/',
    request_id: String(requestId || '').trim() || null,
    source: 'data-api-worker',
    updated_at: nowIso
  };
}

function shouldReplaceCanonicalUserDataRow(currentRow, nextRow) {
  if (!currentRow) return true;
  const currentUpdatedAtMs = Number(currentRow?.updated_at_ms || 0) || 0;
  const nextUpdatedAtMs = Number(nextRow?.updated_at_ms || 0) || 0;
  if (nextUpdatedAtMs > currentUpdatedAtMs) return true;
  if (nextUpdatedAtMs < currentUpdatedAtMs) return false;
  const currentDeletedAtMs = Number(currentRow?.deleted_at_ms || 0) || 0;
  const nextDeletedAtMs = Number(nextRow?.deleted_at_ms || 0) || 0;
  if (nextDeletedAtMs > currentDeletedAtMs) return true;
  if (nextDeletedAtMs < currentDeletedAtMs) return false;
  const currentOpId = String(currentRow?.op_id || '');
  const nextOpId = String(nextRow?.op_id || '');
  return nextOpId >= currentOpId;
}

function compactCanonicalUserDataRows(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    if (!row) return;
    const key = [
      String(row?.user_id || '').trim(),
      String(row?.data_scope || '').trim(),
      String(row?.data_group || '').trim(),
      String(row?.data_key || '').trim()
    ].join('|');
    if (!key.replace(/\|/g, '')) return;
    const current = map.get(key);
    if (shouldReplaceCanonicalUserDataRow(current, row)) {
      map.set(key, row);
    }
  });
  return [...map.values()];
}

function chunkRows(rows = [], size = 250) {
  const normalizedSize = Math.max(1, Number(size || 1) || 1);
  const chunks = [];
  for (let index = 0; index < rows.length; index += normalizedSize) {
    chunks.push(rows.slice(index, index + normalizedSize));
  }
  return chunks;
}

function buildCanonicalRowsFromRequest({
  path = '',
  userId = '',
  requestId = '',
  requestBody = null,
  responseBody = null
} = {}) {
  const normalizedPath = String(path || '').trim();
  const nowMs = Date.now();
  const email = responseBody?.email || requestBody?.email || null;
  const profileMetadata = {
    requestId: String(requestId || '').trim() || null,
    path: normalizedPath || '/',
    atMs: nowMs
  };
  const profileRow = createCanonicalProfileRow({
    userId,
    path: normalizedPath,
    metadata: profileMetadata,
    email
  });
  const userDataRows = [];
  let markAllDeletedAtMs = null;

  if (normalizedPath === '/') {
    const snapshot = extractSnapshotFromSaveBody(requestBody || {});
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
      userDataRows.push(createCanonicalUserDataRow({
        userId,
        scope: 'snapshot',
        group: 'snapshot',
        key: 'snapshot',
        payload: snapshot,
        updatedAtMs: snapshot?.meta?.updatedAtMs || nowMs,
        deletedAtMs: null,
        sourcePath: '/',
        requestId
      }));
      profileRow.metadata_json = {
        ...(profileRow.metadata_json || {}),
        snapshotSchema: String(snapshot?.schema || '').trim() || null
      };
    }
  } else if (normalizedPath === '/sync/lists/push') {
    const operations = Array.isArray(requestBody?.operations) ? requestBody.operations : [];
    operations.forEach((rawOperation) => {
      const operation = toCanonicalListOperation(rawOperation);
      if (!operation) return;
      userDataRows.push(createCanonicalUserDataRow({
        userId,
        scope: 'list',
        group: operation.listKey,
        key: operation.itemKey,
        payload: operation.payload,
        updatedAtMs: operation.updatedAtMs,
        deletedAtMs: operation.deleted ? operation.updatedAtMs : null,
        sourcePath: normalizedPath,
        requestId
      }));
    });
  } else if (normalizedPath === '/sync/sectors/push' || normalizedPath === '/sync/sectors/bootstrap') {
    const operations = Array.isArray(requestBody?.operations) ? requestBody.operations : [];
    operations.forEach((rawOperation) => {
      const operation = toCanonicalSectorOperation(rawOperation);
      if (!operation) return;
      userDataRows.push(createCanonicalUserDataRow({
        userId,
        scope: 'sector',
        group: operation.sectorKey,
        key: operation.itemKey,
        payload: operation.payload,
        updatedAtMs: operation.updatedAtMs,
        deletedAtMs: operation.deleted ? operation.updatedAtMs : null,
        sourcePath: normalizedPath,
        requestId,
        opId: operation.opId
      }));
    });
  } else if (normalizedPath === '/account/reset') {
    markAllDeletedAtMs = nowMs;
    userDataRows.push(createCanonicalUserDataRow({
      userId,
      scope: 'account',
      group: 'account',
      key: 'reset',
      payload: {
        deleted: responseBody?.deleted || null
      },
      updatedAtMs: nowMs,
      deletedAtMs: null,
      sourcePath: normalizedPath,
      requestId
    }));
  }

  return {
    profileRow,
    userDataRows: compactCanonicalUserDataRows(userDataRows),
    markAllDeletedAtMs
  };
}

async function performSupabaseCanonicalRequest({
  config,
  url = '',
  method = 'POST',
  requestId = '',
  body = null,
  preferHeader = 'return=minimal',
  acceptHeader = 'application/json',
  expectJson = false
} = {}) {
  const totalAttempts = Math.max(1, (Number(config?.maxRetries || 0) || 0) + 1);
  let lastFailureStatus = 0;
  let lastFailureMessage = 'supabase canonical request failed';
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const attemptNumber = attempt + 1;
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), Number(config?.timeoutMs || 10_000) || 10_000);
    try {
      const headers = {
        apikey: String(config?.serviceRoleKey || ''),
        authorization: `Bearer ${String(config?.serviceRoleKey || '')}`,
        accept: String(acceptHeader || 'application/json'),
        prefer: String(preferHeader || 'return=minimal')
      };
      if (body !== null && typeof body !== 'undefined') {
        headers['content-type'] = 'application/json';
      }
      const response = await fetch(url, {
        method: String(method || 'POST').toUpperCase(),
        headers,
        body: body === null || typeof body === 'undefined' ? undefined : JSON.stringify(body),
        signal: abortController.signal
      });
      if (response.ok) {
        let data = null;
        if (expectJson) {
          const responseText = await response.text().catch(() => '');
          if (responseText) {
            try {
              data = JSON.parse(responseText);
            } catch (error) {
              throw new Error(`supabase canonical invalid json response: ${String(error?.message || error || 'unknown')}`);
            }
          } else {
            data = [];
          }
        }
        return {
          ok: true,
          status: Number(response.status || 0) || 0,
          error: '',
          data
        };
      }
      const responseText = await response.text().catch(() => '');
      const statusCode = Number(response.status || 0) || 0;
      lastFailureStatus = statusCode;
      lastFailureMessage = `HTTP ${statusCode}: ${responseText.slice(0, 240)}`;
      const canRetry = attemptNumber < totalAttempts && shouldRetrySupabaseMirrorStatus(statusCode);
      if (!canRetry) break;
      const delayMs = computeSupabaseMirrorRetryDelayMs({
        attempt,
        baseMs: config.retryBaseMs,
        jitterMs: config.retryJitterMs
      });
      console.warn(`[api][${requestId || 'no-request-id'}] supabase canonical retry ${attemptNumber}/${totalAttempts - 1} after HTTP ${statusCode}`);
      await waitForSupabaseMirrorRetry(delayMs);
    } catch (error) {
      lastFailureStatus = 0;
      lastFailureMessage = error?.name === 'AbortError'
        ? 'supabase canonical request timed out'
        : `supabase canonical request failed: ${String(error?.message || error || 'unknown')}`;
      const canRetry = attemptNumber < totalAttempts;
      if (!canRetry) break;
      const delayMs = computeSupabaseMirrorRetryDelayMs({
        attempt,
        baseMs: config.retryBaseMs,
        jitterMs: config.retryJitterMs
      });
      console.warn(`[api][${requestId || 'no-request-id'}] supabase canonical retry ${attemptNumber}/${totalAttempts - 1} after error`);
      await waitForSupabaseMirrorRetry(delayMs);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return {
    ok: false,
    status: lastFailureStatus,
    error: lastFailureMessage,
    data: null
  };
}

function parseCanonicalPayloadObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function buildSupabaseInFilter(values = []) {
  const normalized = Array.isArray(values)
    ? values
      .map((value) => String(value || '').trim())
      .filter(Boolean)
    : [];
  if (!normalized.length) return '';
  const encoded = normalized
    .map((value) => `"${value.replace(/"/g, '""')}"`)
    .join(',');
  return `(${encoded})`;
}

function buildCanonicalUserDataCompositeKey(scope = '', group = '', key = '') {
  return [
    String(scope || '').trim(),
    String(group || '').trim(),
    String(key || '').trim()
  ].join('|');
}

function mapCanonicalRowsByCompositeKey(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    if (!row || typeof row !== 'object') return;
    const rowKey = buildCanonicalUserDataCompositeKey(
      row?.data_scope,
      row?.data_group,
      row?.data_key
    );
    if (!rowKey.replace(/\|/g, '')) return;
    const current = map.get(rowKey);
    if (shouldReplaceCanonicalUserDataRow(current, row)) {
      map.set(rowKey, row);
    }
  });
  return map;
}

async function selectSupabaseCanonicalRows({
  config,
  table = '',
  select = '*',
  searchParams = null,
  order = '',
  limit = 0,
  requestId = ''
} = {}) {
  const params = {
    ...(searchParams && typeof searchParams === 'object' ? searchParams : {})
  };
  params.select = String(select || '*');
  if (order) params.order = String(order);
  if (Number(limit || 0) > 0) params.limit = Number(limit || 0);
  const result = await performSupabaseCanonicalRequest({
    config,
    url: buildSupabaseTableUrl({
      projectUrl: config.projectUrl,
      table,
      searchParams: params
    }),
    method: 'GET',
    requestId,
    body: null,
    preferHeader: 'return=representation',
    acceptHeader: 'application/json',
    expectJson: true
  });
  return {
    ok: result.ok,
    status: result.status,
    error: result.error,
    rows: result.ok && Array.isArray(result.data) ? result.data : []
  };
}

async function upsertSupabaseCanonicalProfileRow({
  config,
  userId = '',
  path = '/',
  requestId = '',
  email = null,
  metadata = null
} = {}) {
  const profileRow = createCanonicalProfileRow({
    userId,
    path,
    metadata,
    email
  });
  const result = await upsertSupabaseCanonicalRows({
    config,
    table: config.profileTable,
    rows: [profileRow],
    onConflict: 'user_id',
    requestId
  });
  return {
    ...result,
    profileRow
  };
}

async function persistSnapshotToSupabaseCanonical({
  config,
  userId = '',
  snapshot = null,
  requestId = '',
  sourcePath = '/',
  email = null
} = {}) {
  const nowMs = Date.now();
  const snapshotRow = createCanonicalUserDataRow({
    userId,
    scope: 'snapshot',
    group: 'snapshot',
    key: 'snapshot',
    payload: snapshot,
    updatedAtMs: snapshot?.meta?.updatedAtMs || nowMs,
    deletedAtMs: null,
    sourcePath,
    requestId
  });
  const profileMetadata = {
    requestId: String(requestId || '').trim() || null,
    path: sourcePath,
    atMs: nowMs,
    snapshotSchema: String(snapshot?.schema || '').trim() || null
  };
  const profileResult = await upsertSupabaseCanonicalProfileRow({
    config,
    userId,
    path: sourcePath,
    requestId,
    metadata: profileMetadata,
    email
  });
  if (!profileResult.ok) return profileResult;
  return await upsertSupabaseCanonicalRows({
    config,
    table: config.userDataTable,
    rows: [snapshotRow],
    onConflict: 'user_id,data_scope,data_group,data_key',
    requestId
  });
}

async function readSupabaseSnapshotRow({ config, userId = '', requestId = '' } = {}) {
  const query = await selectSupabaseCanonicalRows({
    config,
    table: config.userDataTable,
    select: 'payload_json,updated_at_ms,deleted_at_ms',
    searchParams: {
      user_id: `eq.${userId}`,
      data_scope: 'eq.snapshot',
      data_group: 'eq.snapshot',
      data_key: 'eq.snapshot',
      deleted_at_ms: 'is.null'
    },
    order: 'updated_at_ms.desc',
    limit: 1,
    requestId
  });
  if (!query.ok) {
    return {
      ok: false,
      status: query.status,
      error: query.error,
      row: null
    };
  }
  return {
    ok: true,
    status: query.status,
    error: '',
    row: query.rows[0] || null
  };
}

function formatSupabaseSyncStateFromPayload(payload = null) {
  const state = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const migratedAtMs = Number(state?.migratedAtMs || 0) || null;
  const migrationSource = String(state?.migrationSource || '').trim() || null;
  const updatedAtMs = Number(state?.updatedAtMs || 0) || migratedAtMs || null;
  return {
    migratedAtMs,
    migrationSource,
    updatedAtMs
  };
}

async function readSupabaseSyncState({ config, userId = '', requestId = '' } = {}) {
  const query = await selectSupabaseCanonicalRows({
    config,
    table: config.userDataTable,
    select: 'payload_json,updated_at_ms,deleted_at_ms',
    searchParams: {
      user_id: `eq.${userId}`,
      data_scope: `eq.${SUPABASE_SYNC_STATE_SCOPE}`,
      data_group: `eq.${SUPABASE_SYNC_STATE_GROUP}`,
      data_key: `eq.${SUPABASE_SYNC_STATE_KEY}`,
      deleted_at_ms: 'is.null'
    },
    order: 'updated_at_ms.desc',
    limit: 1,
    requestId
  });
  if (!query.ok) {
    return {
      ok: false,
      status: query.status,
      error: query.error,
      state: {
        migratedAtMs: null,
        migrationSource: null,
        updatedAtMs: null
      }
    };
  }
  const row = query.rows[0] || null;
  const payload = parseCanonicalPayloadObject(row?.payload_json);
  return {
    ok: true,
    status: query.status,
    error: '',
    state: formatSupabaseSyncStateFromPayload(payload)
  };
}

async function persistSupabaseSyncState({
  config,
  userId = '',
  state = null,
  requestId = '',
  sourcePath = '/sync/sectors/bootstrap'
} = {}) {
  const normalized = formatSupabaseSyncStateFromPayload(state);
  const row = createCanonicalUserDataRow({
    userId,
    scope: SUPABASE_SYNC_STATE_SCOPE,
    group: SUPABASE_SYNC_STATE_GROUP,
    key: SUPABASE_SYNC_STATE_KEY,
    payload: normalized,
    updatedAtMs: normalized.updatedAtMs || normalized.migratedAtMs || Date.now(),
    deletedAtMs: null,
    sourcePath,
    requestId
  });
  return await upsertSupabaseCanonicalRows({
    config,
    table: config.userDataTable,
    rows: [row],
    onConflict: 'user_id,data_scope,data_group,data_key',
    requestId
  });
}

async function loadSupabaseCanonicalRowsForScope({
  config,
  userId = '',
  scope = '',
  groups = [],
  requestId = ''
} = {}) {
  const searchParams = {
    user_id: `eq.${userId}`,
    data_scope: `eq.${scope}`
  };
  const groupFilter = buildSupabaseInFilter(groups);
  if (groupFilter) {
    searchParams.data_group = `in.${groupFilter}`;
  }
  const query = await selectSupabaseCanonicalRows({
    config,
    table: config.userDataTable,
    select: 'data_scope,data_group,data_key,op_id,payload_json,updated_at_ms,deleted_at_ms',
    searchParams,
    order: 'updated_at_ms.desc',
    limit: 20000,
    requestId
  });
  return query;
}

async function upsertSupabaseCanonicalOperations({
  config,
  userId = '',
  scope = '',
  sourcePath = '',
  requestId = '',
  operations = [],
  groups = [],
  email = null
} = {}) {
  const existingQuery = await loadSupabaseCanonicalRowsForScope({
    config,
    userId,
    scope,
    groups,
    requestId
  });
  if (!existingQuery.ok) return existingQuery;
  const existingMap = mapCanonicalRowsByCompositeKey(existingQuery.rows);
  const rowsToWrite = [];
  operations.forEach((row) => {
    if (!row || typeof row !== 'object') return;
    const key = buildCanonicalUserDataCompositeKey(
      row?.data_scope,
      row?.data_group,
      row?.data_key
    );
    if (!key.replace(/\|/g, '')) return;
    const currentRow = existingMap.get(key);
    if (shouldReplaceCanonicalUserDataRow(currentRow, row)) {
      rowsToWrite.push(row);
      existingMap.set(key, row);
    }
  });
  const upsertResult = await upsertSupabaseCanonicalRows({
    config,
    table: config.userDataTable,
    rows: rowsToWrite,
    onConflict: 'user_id,data_scope,data_group,data_key',
    requestId
  });
  if (!upsertResult.ok) return upsertResult;
  await upsertSupabaseCanonicalProfileRow({
    config,
    userId,
    path: sourcePath || '/',
    requestId,
    email,
    metadata: {
      requestId: String(requestId || '').trim() || null,
      path: sourcePath || '/',
      atMs: Date.now()
    }
  });
  return {
    ok: true,
    status: upsertResult.status,
    error: '',
    written: rowsToWrite.length
  };
}

async function upsertSupabaseCanonicalRows({
  config,
  table = '',
  rows = [],
  onConflict = '',
  requestId = ''
} = {}) {
  const normalizedRows = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  if (!normalizedRows.length) {
    return { ok: true, status: 0, error: '' };
  }
  const chunks = chunkRows(normalizedRows, config.batchSize);
  let lastStatus = 0;
  let lastError = '';
  for (const chunk of chunks) {
    const result = await performSupabaseCanonicalRequest({
      config,
      url: buildSupabaseTableUrl({
        projectUrl: config.projectUrl,
        table,
        searchParams: {
          on_conflict: onConflict
        }
      }),
      method: 'POST',
      requestId,
      body: chunk,
      preferHeader: 'resolution=merge-duplicates,return=minimal,missing=default'
    });
    if (!result.ok) {
      lastStatus = result.status;
      lastError = result.error;
      return {
        ok: false,
        status: lastStatus,
        error: lastError
      };
    }
    lastStatus = result.status;
  }
  return {
    ok: true,
    status: lastStatus,
    error: ''
  };
}

async function markSupabaseCanonicalRowsDeletedForUser({
  config,
  userId = '',
  deletedAtMs = 0,
  requestId = '',
  sourcePath = '/account/reset'
} = {}) {
  const normalizedDeletedAtMs = normalizeUpdatedAtMs(deletedAtMs || Date.now());
  const result = await performSupabaseCanonicalRequest({
    config,
    url: buildSupabaseTableUrl({
      projectUrl: config.projectUrl,
      table: config.userDataTable,
      searchParams: {
        user_id: `eq.${userId}`,
        deleted_at_ms: 'is.null'
      }
    }),
    method: 'PATCH',
    requestId,
    body: {
      deleted_at_ms: normalizedDeletedAtMs,
      source_path: sourcePath,
      request_id: String(requestId || '').trim() || null,
      source: 'data-api-worker',
      updated_at: new Date().toISOString()
    },
    preferHeader: 'return=minimal'
  });
  return result;
}

async function mirrorCanonicalDataToSupabase({
  env,
  path = '',
  method = 'POST',
  userId = '',
  requestId = '',
  requestBody = null,
  responseBody = null,
  status = 200
} = {}) {
  const config = resolveSupabaseCanonicalConfig(env);
  if (!config.active) return false;
  if (!shouldWriteCanonicalSupabase(path, method, status)) return false;
  const normalizedUserId = sanitizeMirrorUserId(userId);
  if (!normalizedUserId) return false;

  SUPABASE_CANONICAL_RUNTIME.attempted += 1;
  SUPABASE_CANONICAL_RUNTIME.lastAttemptAtMs = Date.now();

  const {
    profileRow,
    userDataRows,
    markAllDeletedAtMs
  } = buildCanonicalRowsFromRequest({
    path,
    userId: normalizedUserId,
    requestId,
    requestBody,
    responseBody
  });
  let failedStatus = 0;
  let failedMessage = '';

  const profileResult = await upsertSupabaseCanonicalRows({
    config,
    table: config.profileTable,
    rows: profileRow ? [profileRow] : [],
    onConflict: 'user_id',
    requestId
  });
  if (!profileResult.ok) {
    failedStatus = profileResult.status;
    failedMessage = profileResult.error || 'supabase canonical profile upsert failed';
  }

  if (!failedMessage && markAllDeletedAtMs) {
    const markDeletedResult = await markSupabaseCanonicalRowsDeletedForUser({
      config,
      userId: normalizedUserId,
      deletedAtMs: markAllDeletedAtMs,
      requestId
    });
    if (!markDeletedResult.ok) {
      failedStatus = markDeletedResult.status;
      failedMessage = markDeletedResult.error || 'supabase canonical account reset delete mark failed';
    }
  }

  if (!failedMessage && userDataRows.length) {
    const userDataResult = await upsertSupabaseCanonicalRows({
      config,
      table: config.userDataTable,
      rows: userDataRows,
      onConflict: 'user_id,data_scope,data_group,data_key',
      requestId
    });
    if (!userDataResult.ok) {
      failedStatus = userDataResult.status;
      failedMessage = userDataResult.error || 'supabase canonical user data upsert failed';
    }
  }

  if (!failedMessage) {
    SUPABASE_CANONICAL_RUNTIME.succeeded += 1;
    SUPABASE_CANONICAL_RUNTIME.lastSuccessAtMs = Date.now();
    SUPABASE_CANONICAL_RUNTIME.lastFailureStatus = 0;
    SUPABASE_CANONICAL_RUNTIME.lastError = '';
    return true;
  }

  SUPABASE_CANONICAL_RUNTIME.failed += 1;
  SUPABASE_CANONICAL_RUNTIME.lastFailureAtMs = Date.now();
  SUPABASE_CANONICAL_RUNTIME.lastFailureStatus = Number(failedStatus || 0) || 0;
  SUPABASE_CANONICAL_RUNTIME.lastError = failedMessage;
  console.warn(`[api][${requestId || 'no-request-id'}] ${failedMessage}`);
  return false;
}

async function purgeExpiredSupabaseCanonicalRows({ env }) {
  const config = resolveSupabaseCanonicalConfig(env);
  const checkedAtMs = Date.now();
  if (!config.active) {
    return {
      ok: false,
      active: false,
      checkedAtMs,
      cutoffMs: null,
      status: 0,
      error: 'supabase_canonical_inactive'
    };
  }
  const cutoffMs = checkedAtMs - (Math.max(1, Number(config.deletedRetentionDays || SUPABASE_CANONICAL_DELETED_RETENTION_DAYS)) * 24 * 60 * 60 * 1000);
  SUPABASE_CANONICAL_RUNTIME.purgeAttempted += 1;
  SUPABASE_CANONICAL_RUNTIME.lastPurgeAtMs = checkedAtMs;
  SUPABASE_CANONICAL_RUNTIME.lastPurgeCutoffMs = cutoffMs;

  const result = await performSupabaseCanonicalRequest({
    config,
    url: buildSupabaseTableUrl({
      projectUrl: config.projectUrl,
      table: config.userDataTable,
      searchParams: {
        deleted_at_ms: [
          `not.is.null`,
          `lt.${cutoffMs}`
        ]
      }
    }),
    method: 'DELETE',
    requestId: 'scheduled-purge',
    body: null,
    preferHeader: 'return=minimal'
  });

  if (result.ok) {
    SUPABASE_CANONICAL_RUNTIME.purgeSucceeded += 1;
    SUPABASE_CANONICAL_RUNTIME.lastPurgeStatus = Number(result.status || 0) || 0;
    SUPABASE_CANONICAL_RUNTIME.lastPurgeError = '';
    return {
      ok: true,
      active: true,
      checkedAtMs,
      cutoffMs,
      status: Number(result.status || 0) || 0,
      error: ''
    };
  }

  SUPABASE_CANONICAL_RUNTIME.purgeFailed += 1;
  SUPABASE_CANONICAL_RUNTIME.lastPurgeStatus = Number(result.status || 0) || 0;
  SUPABASE_CANONICAL_RUNTIME.lastPurgeError = String(result.error || 'supabase canonical purge failed');
  return {
    ok: false,
    active: true,
    checkedAtMs,
    cutoffMs,
    status: Number(result.status || 0) || 0,
    error: String(result.error || 'supabase canonical purge failed')
  };
}

async function upsertAccountCapabilityFromAuthPayload({
  env,
  userId = '',
  payload = null,
  requestId = ''
} = {}) {
  const normalizedUserId = normalizeUserId(userId);
  if (!isValidUserId(normalizedUserId)) return;
  const email = canonicalizeEmailForMatching(payload?.email || '');
  if (!isValidEmail(email)) return;
  const db = getD1Database(env);
  if (!db) return;

  try {
    await upsertAccountUserCapability({
      db,
      userId: normalizedUserId,
      email
    });
  } catch (error) {
    console.warn(`[api][${requestId || 'no-request-id'}] account capability upsert skipped: ${String(error?.message || error || 'unknown')}`);
  }
}

async function mirrorWriteEventToSupabase({
  env,
  path = '',
  method = 'POST',
  userId = '',
  requestId = '',
  requestBody = null,
  responseBody = null,
  status = 200
} = {}) {
  const config = resolveSupabaseMirrorConfig(env);
  if (!config.active) return false;
  if (!shouldMirrorToSupabase(path, method, status)) return false;

  SUPABASE_MIRROR_RUNTIME.attempted += 1;
  SUPABASE_MIRROR_RUNTIME.lastAttemptAtMs = Date.now();

  const occurredAt = new Date().toISOString();
  const eventId = createUuidV4();
  const requestSummary = toMirrorBodySummary(requestBody);
  const responseSummary = toMirrorBodySummary(responseBody);
  const event = {
    event_id: eventId,
    idempotency_key: eventId,
    source: 'data-api-worker',
    occurred_at: occurredAt,
    mirrored_at: new Date().toISOString(),
    user_id: sanitizeMirrorUserId(userId),
    method: String(method || '').toUpperCase(),
    path: String(path || '').trim(),
    query_params: {},
    request_headers: {
      'x-request-id': String(requestId || '').trim() || null
    },
    request_content_type: 'application/json',
    request_body_json: requestSummary.json,
    request_body_text: requestSummary.text,
    request_body_bytes: requestSummary.bytes,
    response_status: Number(status || 0) || 0,
    response_content_type: 'application/json',
    response_body_json: responseSummary.json,
    response_body_text: responseSummary.text,
    response_body_bytes: responseSummary.bytes,
    retry_count: 0
  };
  const totalAttempts = Math.max(1, (Number(config.maxRetries || 0) || 0) + 1);
  let lastFailureStatus = 0;
  let lastFailureMessage = 'supabase mirror write failed';

  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const attemptNumber = attempt + 1;
    event.retry_count = attempt;
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), config.timeoutMs);
    try {
      const response = await fetch(buildSupabaseMirrorUrl(config), {
        method: 'POST',
        headers: {
          apikey: config.serviceRoleKey,
          authorization: `Bearer ${config.serviceRoleKey}`,
          'content-type': 'application/json',
          prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify([event]),
        signal: abortController.signal
      });

      if (response.ok) {
        SUPABASE_MIRROR_RUNTIME.succeeded += 1;
        SUPABASE_MIRROR_RUNTIME.lastSuccessAtMs = Date.now();
        SUPABASE_MIRROR_RUNTIME.lastFailureStatus = 0;
        SUPABASE_MIRROR_RUNTIME.lastError = '';
        return true;
      }

      const responseText = await response.text().catch(() => '');
      const statusCode = Number(response.status || 0) || 0;
      lastFailureStatus = statusCode;
      lastFailureMessage = `HTTP ${statusCode}: ${responseText.slice(0, 240)}`;

      const canRetry = (attemptNumber < totalAttempts) && shouldRetrySupabaseMirrorStatus(statusCode);
      if (!canRetry) {
        console.warn(`[api][${requestId || 'no-request-id'}] supabase mirror write failed (${statusCode}): ${responseText.slice(0, 300)}`);
        break;
      }

      const delayMs = computeSupabaseMirrorRetryDelayMs({
        attempt,
        baseMs: config.retryBaseMs,
        jitterMs: config.retryJitterMs
      });
      console.warn(`[api][${requestId || 'no-request-id'}] supabase mirror write retry ${attemptNumber}/${totalAttempts - 1} after HTTP ${statusCode}`);
      await waitForSupabaseMirrorRetry(delayMs);
    } catch (error) {
      lastFailureStatus = 0;
      lastFailureMessage = error?.name === 'AbortError'
        ? 'supabase mirror write timed out'
        : `supabase mirror request failed: ${String(error?.message || error || 'unknown')}`;

      const canRetry = attemptNumber < totalAttempts;
      if (!canRetry) {
        console.warn(`[api][${requestId || 'no-request-id'}] ${lastFailureMessage}`);
        break;
      }

      const delayMs = computeSupabaseMirrorRetryDelayMs({
        attempt,
        baseMs: config.retryBaseMs,
        jitterMs: config.retryJitterMs
      });
      console.warn(`[api][${requestId || 'no-request-id'}] supabase mirror write retry ${attemptNumber}/${totalAttempts - 1} after error`);
      await waitForSupabaseMirrorRetry(delayMs);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  SUPABASE_MIRROR_RUNTIME.failed += 1;
  SUPABASE_MIRROR_RUNTIME.lastFailureAtMs = Date.now();
  SUPABASE_MIRROR_RUNTIME.lastFailureStatus = lastFailureStatus;
  SUPABASE_MIRROR_RUNTIME.lastError = lastFailureMessage;
  return false;
}

async function probeSupabaseMirrorConnection(env) {
  const config = resolveSupabaseMirrorConfig(env);
  const checkedAtMs = Date.now();
  if (!config.active) {
    SUPABASE_MIRROR_RUNTIME.lastProbeAtMs = checkedAtMs;
    SUPABASE_MIRROR_RUNTIME.lastProbeStatus = 0;
    SUPABASE_MIRROR_RUNTIME.lastProbeOk = false;
    SUPABASE_MIRROR_RUNTIME.lastProbeError = 'supabase_mirror_inactive';
    return {
      checkedAtMs,
      active: false,
      ok: false,
      status: 0,
      error: 'supabase_mirror_inactive'
    };
  }

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), config.timeoutMs);
  try {
    const response = await fetch(buildSupabaseMirrorProbeUrl(config), {
      method: 'GET',
      headers: {
        apikey: config.serviceRoleKey,
        authorization: `Bearer ${config.serviceRoleKey}`,
        accept: 'application/json'
      },
      signal: abortController.signal
    });
    const ok = response.ok;
    const status = Number(response.status || 0) || 0;
    const responseText = ok ? '' : (await response.text().catch(() => ''));
    const error = ok ? '' : `HTTP ${status}: ${responseText.slice(0, 240)}`;
    SUPABASE_MIRROR_RUNTIME.lastProbeAtMs = checkedAtMs;
    SUPABASE_MIRROR_RUNTIME.lastProbeStatus = status;
    SUPABASE_MIRROR_RUNTIME.lastProbeOk = ok;
    SUPABASE_MIRROR_RUNTIME.lastProbeError = error;
    return {
      checkedAtMs,
      active: true,
      ok,
      status,
      error
    };
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'supabase_probe_timeout'
      : `supabase_probe_failed: ${String(error?.message || error || 'unknown')}`;
    SUPABASE_MIRROR_RUNTIME.lastProbeAtMs = checkedAtMs;
    SUPABASE_MIRROR_RUNTIME.lastProbeStatus = 0;
    SUPABASE_MIRROR_RUNTIME.lastProbeOk = false;
    SUPABASE_MIRROR_RUNTIME.lastProbeError = message;
    return {
      checkedAtMs,
      active: true,
      ok: false,
      status: 0,
      error: message
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function queueSupabaseMirrorWrite({
  executionContext = null,
  env,
  path = '',
  method = 'POST',
  userId = '',
  requestId = '',
  requestBody = null,
  responseBody = null,
  status = 200
} = {}) {
  const canonicalConfig = resolveSupabaseCanonicalConfig(env);
  const canonicalPrimaryActive = isSupabaseCanonicalPrimaryActive(env, canonicalConfig);
  const mirrorTask = mirrorWriteEventToSupabase({
    env,
    path,
    method,
    userId,
    requestId,
    requestBody,
    responseBody,
    status
  });
  const tasks = [mirrorTask];
  if (!canonicalPrimaryActive) {
    tasks.push(mirrorCanonicalDataToSupabase({
      env,
      path,
      method,
      userId,
      requestId,
      requestBody,
      responseBody,
      status
    }));
  }
  const task = Promise.allSettled(tasks);
  if (executionContext && typeof executionContext.waitUntil === 'function') {
    executionContext.waitUntil(task);
    return;
  }
  void task;
}

function getAccountLinkRateLimitPolicy(env, kind = 'read') {
  const normalizedKind = kind === 'mutation' ? 'mutation' : 'read';
  const defaults = DEFAULT_ACCOUNT_LINK_RATE_LIMITS[normalizedKind];
  const envPrefix = normalizedKind === 'mutation'
    ? 'ACCOUNT_LINK_RATE_LIMIT_MUTATION'
    : 'ACCOUNT_LINK_RATE_LIMIT_READ';
  return {
    limit: parseEnvInt(env, envPrefix, defaults.limit, { min: 1, max: 1000 }),
    windowMs: parseEnvInt(env, `${envPrefix}_WINDOW_MS`, defaults.windowMs, { min: 1000, max: 60 * 60 * 1000 })
  };
}

function sweepAccountLinkRateLimitStore(nowMs) {
  if (nowMs < nextAccountLinkRateLimitSweepAtMs && ACCOUNT_LINK_RATE_LIMIT_STORE.size < ACCOUNT_LINK_RATE_LIMIT_STORE_SOFT_CAP) return;
  for (const [key, entry] of ACCOUNT_LINK_RATE_LIMIT_STORE.entries()) {
    if (!entry || Number(entry.resetAtMs || 0) <= nowMs) {
      ACCOUNT_LINK_RATE_LIMIT_STORE.delete(key);
    }
  }
  nextAccountLinkRateLimitSweepAtMs = nowMs + 60_000;
}

function consumeAccountLinkRateLimit({ key, policy }) {
  const nowMs = Date.now();
  sweepAccountLinkRateLimitStore(nowMs);
  const normalizedLimit = Math.max(1, Number(policy?.limit || 1));
  const windowMs = Math.max(1000, Number(policy?.windowMs || 60_000));
  const storeKey = String(key || 'unknown').slice(0, 160);
  let entry = ACCOUNT_LINK_RATE_LIMIT_STORE.get(storeKey);
  if (!entry || Number(entry.resetAtMs || 0) <= nowMs) {
    entry = { count: 0, resetAtMs: nowMs + windowMs };
  }
  if (entry.count >= normalizedLimit) {
    ACCOUNT_LINK_RATE_LIMIT_STORE.set(storeKey, entry);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAtMs - nowMs) / 1000))
    };
  }
  entry.count += 1;
  ACCOUNT_LINK_RATE_LIMIT_STORE.set(storeKey, entry);
  return {
    allowed: true,
    retryAfterSeconds: 0
  };
}

function getPrivateEndpointRateLimitPolicy(env, kind = 'snapshotRead') {
  const normalizedKind = Object.prototype.hasOwnProperty.call(DEFAULT_PRIVATE_ENDPOINT_RATE_LIMITS, kind)
    ? kind
    : 'snapshotRead';
  const defaults = DEFAULT_PRIVATE_ENDPOINT_RATE_LIMITS[normalizedKind];
  const envPrefix = `BILM_RATE_LIMIT_${normalizedKind.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
  return {
    limit: parseEnvInt(env, envPrefix, defaults.limit, { min: 1, max: 2000 }),
    windowMs: parseEnvInt(env, `${envPrefix}_WINDOW_MS`, defaults.windowMs, { min: 1000, max: 60 * 60 * 1000 })
  };
}

function sweepPrivateEndpointRateLimitStore(nowMs) {
  if (nowMs < nextPrivateEndpointRateLimitSweepAtMs && PRIVATE_ENDPOINT_RATE_LIMIT_STORE.size < PRIVATE_ENDPOINT_RATE_LIMIT_STORE_SOFT_CAP) return;
  for (const [key, entry] of PRIVATE_ENDPOINT_RATE_LIMIT_STORE.entries()) {
    if (!entry || Number(entry.resetAtMs || 0) <= nowMs) {
      PRIVATE_ENDPOINT_RATE_LIMIT_STORE.delete(key);
    }
  }
  nextPrivateEndpointRateLimitSweepAtMs = nowMs + 60_000;
}

function consumePrivateEndpointRateLimit({ key, policy }) {
  const nowMs = Date.now();
  sweepPrivateEndpointRateLimitStore(nowMs);
  const normalizedLimit = Math.max(1, Number(policy?.limit || 1));
  const windowMs = Math.max(1000, Number(policy?.windowMs || 60_000));
  const storeKey = String(key || 'unknown').slice(0, 180);
  let entry = PRIVATE_ENDPOINT_RATE_LIMIT_STORE.get(storeKey);
  if (!entry || Number(entry.resetAtMs || 0) <= nowMs) {
    entry = { count: 0, resetAtMs: nowMs + windowMs };
  }
  if (entry.count >= normalizedLimit) {
    PRIVATE_ENDPOINT_RATE_LIMIT_STORE.set(storeKey, entry);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAtMs - nowMs) / 1000))
    };
  }
  entry.count += 1;
  PRIVATE_ENDPOINT_RATE_LIMIT_STORE.set(storeKey, entry);
  return {
    allowed: true,
    retryAfterSeconds: 0
  };
}

function enforcePrivateEndpointRateLimit({ env, userId, corsOrigin, requestId, kind = 'snapshotRead' }) {
  const policy = getPrivateEndpointRateLimitPolicy(env, kind);
  const normalizedUserId = normalizeUserId(userId) || 'anonymous';
  const state = consumePrivateEndpointRateLimit({
    key: `private:${kind}:${normalizedUserId}`,
    policy
  });
  if (state.allowed) return;
  throw errorResponse(429, {
    error: 'rate_limited',
    message: 'Too many private data requests. Please wait and try again.',
    retryable: true,
    code: 'private_data_rate_limited',
    requestId
  }, corsOrigin, {
    'retry-after': String(state.retryAfterSeconds)
  });
}

function getSupabaseCanonicalReadCooldownMs(env) {
  return parseEnvInt(env, 'SUPABASE_CANONICAL_READ_FAIL_COOLDOWN_MS', 20_000, { min: 0, max: 10 * 60 * 1000 });
}

function sweepSupabaseCanonicalReadCooldownStore(nowMs) {
  if (
    nowMs < nextSupabaseCanonicalReadCooldownSweepAtMs
    && SUPABASE_CANONICAL_READ_COOLDOWN_STORE.size < SUPABASE_CANONICAL_READ_COOLDOWN_SOFT_CAP
  ) {
    return;
  }
  for (const [key, entry] of SUPABASE_CANONICAL_READ_COOLDOWN_STORE.entries()) {
    if (!entry || Number(entry.untilMs || 0) <= nowMs) {
      SUPABASE_CANONICAL_READ_COOLDOWN_STORE.delete(key);
    }
  }
  nextSupabaseCanonicalReadCooldownSweepAtMs = nowMs + 60_000;
}

function getSupabaseCanonicalReadCooldownState(userId = '') {
  const normalizedUserId = normalizeUserId(userId);
  if (!isValidUserId(normalizedUserId)) {
    return { blocked: false, retryAfterSeconds: 0 };
  }
  const nowMs = Date.now();
  sweepSupabaseCanonicalReadCooldownStore(nowMs);
  const key = `supabase-read:${normalizedUserId}`;
  const entry = SUPABASE_CANONICAL_READ_COOLDOWN_STORE.get(key);
  const untilMs = Number(entry?.untilMs || 0) || 0;
  if (untilMs <= nowMs) {
    SUPABASE_CANONICAL_READ_COOLDOWN_STORE.delete(key);
    return { blocked: false, retryAfterSeconds: 0 };
  }
  return {
    blocked: true,
    retryAfterSeconds: Math.max(1, Math.ceil((untilMs - nowMs) / 1000))
  };
}

function enforceSupabaseCanonicalReadCooldown({ env, userId, corsOrigin, requestId }) {
  const state = getSupabaseCanonicalReadCooldownState(userId);
  if (!state.blocked) return;
  throw errorResponse(503, {
    error: 'storage_unavailable',
    message: 'Supabase canonical storage is temporarily cooling down for this user. Please retry shortly.',
    retryable: true,
    code: 'storage_unavailable',
    requestId
  }, corsOrigin, {
    'retry-after': String(state.retryAfterSeconds)
  });
}

function clearSupabaseCanonicalReadCooldown(userId = '') {
  const normalizedUserId = normalizeUserId(userId);
  if (!isValidUserId(normalizedUserId)) return;
  SUPABASE_CANONICAL_READ_COOLDOWN_STORE.delete(`supabase-read:${normalizedUserId}`);
}

function recordSupabaseCanonicalReadCooldown({ env, userId, status = 0 } = {}) {
  const normalizedUserId = normalizeUserId(userId);
  if (!isValidUserId(normalizedUserId)) return 0;
  const numericStatus = Number(status || 0) || 0;
  const shouldCooldown = numericStatus === 429 || numericStatus >= 500 || numericStatus === 0;
  if (!shouldCooldown) return 0;
  const cooldownMs = getSupabaseCanonicalReadCooldownMs(env);
  if (cooldownMs <= 0) return 0;
  const nowMs = Date.now();
  const key = `supabase-read:${normalizedUserId}`;
  const untilMs = nowMs + cooldownMs;
  SUPABASE_CANONICAL_READ_COOLDOWN_STORE.set(key, {
    untilMs,
    status: numericStatus
  });
  return Math.max(1, Math.ceil(cooldownMs / 1000));
}

function enforceAccountLinkRateLimit({ env, authContext, corsOrigin, requestId, kind = 'read' }) {
  const policy = getAccountLinkRateLimitPolicy(env, kind);
  const actorKey = normalizeUserId(authContext?.userId) || normalizeEmail(authContext?.email) || 'anonymous';
  const state = consumeAccountLinkRateLimit({
    key: `account-link:${kind}:${actorKey}`,
    policy
  });
  if (state.allowed) return;
  throw errorResponse(429, {
    error: 'rate_limited',
    message: 'Too many account-link requests. Please wait and try again.',
    retryable: true,
    code: 'account_link_rate_limited',
    requestId
  }, corsOrigin, {
    'retry-after': String(state.retryAfterSeconds)
  });
}

function isPendingAccountLinkExpired(linkRow, nowMs = Date.now()) {
  const normalized = normalizeAccountLinkRow(linkRow);
  if (normalized.status !== ACCOUNT_LINK_STATUS_PENDING) return false;
  const basis = normalized.createdAtMs || normalized.updatedAtMs || 0;
  return basis > 0 && nowMs - basis > ACCOUNT_LINK_PENDING_TTL_MS;
}

async function expireAccountLinkIfNeeded({ db, link, nowMs = Date.now() }) {
  if (!isPendingAccountLinkExpired(link, nowMs)) return normalizeAccountLinkRow(link);
  const next = {
    ...normalizeAccountLinkRow(link),
    status: ACCOUNT_LINK_STATUS_EXPIRED,
    updatedAtMs: nowMs,
    unlinkedAtMs: nowMs
  };
  await saveAccountLinkRow({ db, link: next });
  return next;
}

async function upsertAccountUserCapability({
  db,
  userId,
  email,
  chatReady = false,
  lastChatSeenAtMs = null
}) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedEmail = canonicalizeEmailForMatching(email);
  if (!normalizedUserId || !isValidEmail(normalizedEmail)) return;
  const nowMs = Date.now();
  await db.prepare(UPSERT_ACCOUNT_USER_CAPABILITY_SQL).bind(
    normalizedUserId,
    normalizedEmail,
    chatReady ? 1 : 0,
    toOptionalTimestamp(lastChatSeenAtMs),
    nowMs
  ).run();
}

async function readAccountUserCapabilityByEmail({ db, email }) {
  const normalizedEmail = canonicalizeEmailForMatching(email);
  if (!normalizedEmail || !isValidEmail(normalizedEmail)) return null;
  const emailVariants = getEmailMatchVariants(normalizedEmail);
  if (!emailVariants.length) return null;
  const placeholders = emailVariants.map((_, index) => `?${index + 1}`).join(', ');
  const statement = db.prepare(`
    SELECT user_id, email, chat_ready, last_chat_seen_at_ms, updated_at_ms
    FROM account_user_capabilities
    WHERE email IN (${placeholders})
    ORDER BY updated_at_ms DESC
    LIMIT 1
  `).bind(...emailVariants);
  const row = await statement.first();
  if (!row) return null;
  return {
    userId: normalizeUserId(row?.user_id),
    email: normalizeEmail(row?.email),
    chatReady: Number(row?.chat_ready || 0) > 0,
    lastChatSeenAtMs: toOptionalTimestamp(row?.last_chat_seen_at_ms),
    updatedAtMs: toOptionalTimestamp(row?.updated_at_ms) || Date.now()
  };
}

function normalizeAccountLinkRow(row = {}) {
  return {
    id: String(row?.id || '').trim(),
    status: String(row?.status || '').trim().toLowerCase(),
    requesterUserId: normalizeUserId(row?.requester_user_id ?? row?.requesterUserId),
    requesterEmail: canonicalizeEmailForMatching(row?.requester_email ?? row?.requesterEmail),
    targetUserId: normalizeUserId(row?.target_user_id ?? row?.targetUserId),
    targetEmail: canonicalizeEmailForMatching(row?.target_email ?? row?.targetEmail),
    requesterShareScopes: row?.requesterShareScopes && typeof row.requesterShareScopes === 'object'
      ? normalizeAccountLinkScopes(row.requesterShareScopes)
      : parseAccountLinkScopesJson(row?.requester_share_scopes_json),
    targetShareScopes: row?.targetShareScopes && typeof row.targetShareScopes === 'object'
      ? normalizeAccountLinkScopes(row.targetShareScopes)
      : parseAccountLinkScopesJson(row?.target_share_scopes_json),
    requesterApprovedAtMs: toOptionalTimestamp(row?.requester_approved_at_ms ?? row?.requesterApprovedAtMs),
    targetApprovedAtMs: toOptionalTimestamp(row?.target_approved_at_ms ?? row?.targetApprovedAtMs),
    createdAtMs: toOptionalTimestamp(row?.created_at_ms ?? row?.createdAtMs) || Date.now(),
    updatedAtMs: toOptionalTimestamp(row?.updated_at_ms ?? row?.updatedAtMs) || Date.now(),
    activatedAtMs: toOptionalTimestamp(row?.activated_at_ms ?? row?.activatedAtMs),
    declinedAtMs: toOptionalTimestamp(row?.declined_at_ms ?? row?.declinedAtMs),
    unlinkedAtMs: toOptionalTimestamp(row?.unlinked_at_ms ?? row?.unlinkedAtMs)
  };
}

function formatAccountLinkForActor(linkRow, actorUserId = '', actorEmail = '') {
  const normalized = normalizeAccountLinkRow(linkRow);
  const role = getAccountLinkRole(normalized, actorUserId, actorEmail);

  const requesterPayload = {
    userId: normalized.requesterUserId || null,
    email: normalized.requesterEmail || null,
    shareScopes: normalizeAccountLinkScopes(normalized.requesterShareScopes),
    approvedAtMs: normalized.requesterApprovedAtMs
  };
  const targetPayload = {
    userId: normalized.targetUserId || null,
    email: normalized.targetEmail || null,
    shareScopes: normalizeAccountLinkScopes(normalized.targetShareScopes),
    approvedAtMs: normalized.targetApprovedAtMs
  };
  const me = role === 'requester' ? requesterPayload : (role === 'target' ? targetPayload : null);
  const partner = role === 'requester' ? targetPayload : (role === 'target' ? requesterPayload : null);

  return {
    id: normalized.id,
    status: normalized.status,
    createdAtMs: normalized.createdAtMs,
    updatedAtMs: normalized.updatedAtMs,
    activatedAtMs: normalized.activatedAtMs,
    declinedAtMs: normalized.declinedAtMs,
    unlinkedAtMs: normalized.unlinkedAtMs,
    requester: requesterPayload,
    target: targetPayload,
    myRole: role || null,
    me,
    partner,
    canApprove: normalized.status === ACCOUNT_LINK_STATUS_PENDING
      && role === 'target'
      && !normalized.targetApprovedAtMs,
    canUpdateScopes: normalized.status === ACCOUNT_LINK_STATUS_ACTIVE && Boolean(role),
    canUnlink: (
      normalized.status === ACCOUNT_LINK_STATUS_ACTIVE
      || normalized.status === ACCOUNT_LINK_STATUS_PENDING
    ) && Boolean(role)
  };
}

async function readAccountLinkById({ db, linkId }) {
  const normalizedLinkId = String(linkId || '').trim();
  if (!normalizedLinkId) return null;
  const row = await db.prepare(SELECT_ACCOUNT_LINK_BY_ID_SQL).bind(normalizedLinkId).first();
  return row ? normalizeAccountLinkRow(row) : null;
}

async function listAccountLinksForActor({ db, userId, email }) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedUserId && !normalizedEmail) return [];
  const emailVariants = getEmailMatchVariants(normalizedEmail);
  const bindings = [];
  const matchClauses = [];

  if (normalizedUserId) {
    bindings.push(normalizedUserId);
    const userIndex = bindings.length;
    matchClauses.push(`requester_user_id = ?${userIndex}`);
    matchClauses.push(`target_user_id = ?${userIndex}`);
  }

  if (emailVariants.length) {
    const requesterStart = bindings.length + 1;
    const requesterPlaceholders = emailVariants.map((_, index) => `?${requesterStart + index}`).join(', ');
    bindings.push(...emailVariants);

    const targetStart = bindings.length + 1;
    const targetPlaceholders = emailVariants.map((_, index) => `?${targetStart + index}`).join(', ');
    bindings.push(...emailVariants);

    matchClauses.push(`requester_email IN (${requesterPlaceholders})`);
    matchClauses.push(`target_email IN (${targetPlaceholders})`);
  }

  if (!matchClauses.length) return [];

  const sql = `
    SELECT
      id,
      status,
      requester_user_id,
      requester_email,
      target_user_id,
      target_email,
      requester_share_scopes_json,
      target_share_scopes_json,
      requester_approved_at_ms,
      target_approved_at_ms,
      created_at_ms,
      updated_at_ms,
      activated_at_ms,
      declined_at_ms,
      unlinked_at_ms
    FROM account_links
    WHERE ${matchClauses.join(' OR ')}
    ORDER BY updated_at_ms DESC
    LIMIT 50
  `;
  const query = await db.prepare(sql).bind(...bindings).all();
  const rows = Array.isArray(query?.results) ? query.results : [];
  return rows.map((row) => normalizeAccountLinkRow(row));
}

async function findBlockingAccountLink({ db, userId, email, excludeLinkId = '' }) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedUserId && !normalizedEmail) return null;
  const emailVariants = getEmailMatchVariants(normalizedEmail);
  const bindings = [];
  const matchClauses = [];

  if (normalizedUserId) {
    bindings.push(normalizedUserId);
    const userIndex = bindings.length;
    matchClauses.push(`requester_user_id = ?${userIndex}`);
    matchClauses.push(`target_user_id = ?${userIndex}`);
  }

  if (emailVariants.length) {
    const requesterStart = bindings.length + 1;
    const requesterPlaceholders = emailVariants.map((_, index) => `?${requesterStart + index}`).join(', ');
    bindings.push(...emailVariants);

    const targetStart = bindings.length + 1;
    const targetPlaceholders = emailVariants.map((_, index) => `?${targetStart + index}`).join(', ');
    bindings.push(...emailVariants);

    matchClauses.push(`requester_email IN (${requesterPlaceholders})`);
    matchClauses.push(`target_email IN (${targetPlaceholders})`);
  }

  if (!matchClauses.length) return null;

  bindings.push(String(excludeLinkId || '').trim());
  const excludeIndex = bindings.length;

  const sql = `
    SELECT id, status, created_at_ms, updated_at_ms
    FROM account_links
    WHERE status IN ('pending', 'active')
      AND id != ?${excludeIndex}
      AND (${matchClauses.join(' OR ')})
    LIMIT 1
  `;
  const row = await db.prepare(sql).bind(...bindings).first();
  if (!row?.id) return null;
  if (isPendingAccountLinkExpired(row)) return null;
  return {
    id: String(row.id || '').trim(),
    status: String(row.status || '').trim().toLowerCase()
  };
}

async function saveAccountLinkRow({ db, link }) {
  const normalized = normalizeAccountLinkRow(link);
  await db.prepare(UPSERT_ACCOUNT_LINK_SQL).bind(
    normalized.id,
    normalized.status,
    normalized.requesterUserId || null,
    normalized.requesterEmail || null,
    normalized.targetUserId || null,
    normalized.targetEmail || null,
    JSON.stringify(normalizeAccountLinkScopes(normalized.requesterShareScopes)),
    JSON.stringify(normalizeAccountLinkScopes(normalized.targetShareScopes)),
    normalized.requesterApprovedAtMs,
    normalized.targetApprovedAtMs,
    normalized.createdAtMs,
    normalized.updatedAtMs,
    normalized.activatedAtMs,
    normalized.declinedAtMs,
    normalized.unlinkedAtMs
  ).run();
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
      ...API_SECURITY_HEADERS,
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

async function writeSnapshotToCloudflareBackup({ env, userId, snapshotJson, metadata, requestId = '' }) {
  let stored = false;
  try {
    if (await writeSnapshotToD1({ env, userId, snapshotJson, metadata })) {
      stored = true;
    }
  } catch (error) {
    console.warn(`[api][${requestId || 'no-request-id'}] cloudflare d1 snapshot backup write failed: ${String(error?.message || error || 'unknown')}`);
  }

  try {
    if (await writeSnapshotToKv({ env, userId, snapshotJson, metadata })) {
      stored = true;
    }
  } catch (error) {
    console.warn(`[api][${requestId || 'no-request-id'}] cloudflare kv snapshot backup write failed: ${String(error?.message || error || 'unknown')}`);
  }

  return stored;
}

async function readSnapshotValueFromCloudflareBackup({ env, userId }) {
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

async function readSnapshotMetaFromCloudflareBackup({ env, userId }) {
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

async function writeListSyncOperationsToD1Backup({
  env,
  userId = '',
  deviceId = null,
  operations = []
} = {}) {
  const db = getD1Database(env);
  if (!db) return false;
  const nowIso = new Date().toISOString();
  const normalizedDeviceId = String(deviceId || '').trim() || null;
  const rows = Array.isArray(operations) ? operations : [];
  for (let index = 0; index < rows.length; index += 1) {
    const operation = rows[index];
    if (!operation || typeof operation !== 'object') continue;
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
        normalizedDeviceId,
        nowIso
      )
      .run();
  }
  return true;
}

async function tryWriteListSyncOperationsToD1Backup(args = {}, requestId = '') {
  try {
    return await writeListSyncOperationsToD1Backup(args);
  } catch (error) {
    console.warn(`[api][${requestId || 'no-request-id'}] cloudflare d1 list sync backup write failed: ${String(error?.message || error || 'unknown')}`);
    return false;
  }
}

async function writeSectorSyncOperationsToD1Backup({
  env,
  userId = '',
  deviceId = null,
  operations = []
} = {}) {
  const db = getD1Database(env);
  if (!db) return false;
  const nowIso = new Date().toISOString();
  const normalizedDeviceId = String(deviceId || '').trim() || null;
  const rows = Array.isArray(operations) ? operations : [];
  for (let index = 0; index < rows.length; index += 1) {
    const operation = rows[index];
    if (!operation || typeof operation !== 'object') continue;
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
        normalizedDeviceId,
        operation.opId,
        nowIso
      )
      .run();
  }
  return true;
}

async function tryWriteSectorSyncOperationsToD1Backup(args = {}, requestId = '') {
  try {
    return await writeSectorSyncOperationsToD1Backup(args);
  } catch (error) {
    console.warn(`[api][${requestId || 'no-request-id'}] cloudflare d1 sector sync backup write failed: ${String(error?.message || error || 'unknown')}`);
    return false;
  }
}

async function readListSyncRowsFromD1Backup({ env, userId, sinceMs, limit }) {
  const db = getD1Database(env);
  if (!db) return null;
  const query = await db.prepare(SELECT_LIST_SYNC_CHANGES_SQL).bind(userId, sinceMs, limit).all();
  return Array.isArray(query?.results) ? query.results : [];
}

async function readSectorSyncRowsFromD1Backup({ env, userId, sinceMs, limit, sectors = [], cursor = null }) {
  const db = getD1Database(env);
  if (!db) return null;
  const query = await buildSectorPullStatement({
    db,
    userId,
    sinceMs,
    limit,
    sectors,
    cursor
  }).all();
  return Array.isArray(query?.results) ? query.results : [];
}

async function readUserSyncStateFromD1Backup({ env, userId }) {
  const db = getD1Database(env);
  if (!db) return null;
  return await readUserSyncState({ db, userId });
}

function logSupabaseFallback(requestId = '', action = '', detail = '') {
  console.warn(`[api][${requestId || 'no-request-id'}] supabase canonical ${action || 'request'} unavailable; using cloudflare backup${detail ? ` (${detail})` : ''}`);
}

async function persistSnapshot({ env, userId, snapshot, corsOrigin, requestId = '', email = null }) {
  assertNoCredentialStorage(snapshot, corsOrigin);

  const metadata = getSnapshotMetadata(snapshot);
  const snapshotJson = JSON.stringify(snapshot || {});
  const snapshotBytes = calculateJsonBytes(snapshotJson);
  if (snapshotBytes > MAX_SNAPSHOT_BYTES) {
    throw jsonResponse(413, {
      error: 'snapshot_too_large',
      message: `Snapshot exceeds maximum size of ${MAX_SNAPSHOT_BYTES.toLocaleString()} bytes.`,
      maxBytes: MAX_SNAPSHOT_BYTES,
      bytes: snapshotBytes
    }, corsOrigin);
  }
  const canonicalConfig = resolveSupabaseCanonicalConfig(env);
  const supabasePrimaryActive = isSupabaseCanonicalPrimaryActive(env, canonicalConfig);
  if (supabasePrimaryActive) {
    const supabaseResult = await persistSnapshotToSupabaseCanonical({
      config: canonicalConfig,
      userId,
      snapshot,
      requestId,
      sourcePath: '/',
      email
    });
    if (!supabaseResult.ok) {
      logSupabaseFallback(requestId, 'snapshot write', supabaseResult.error || `http_${supabaseResult.status || 0}`);
      const fallbackStored = await writeSnapshotToCloudflareBackup({
        env,
        userId,
        snapshotJson,
        metadata,
        requestId
      });
      if (!fallbackStored) {
        throw jsonResponse(503, {
          error: 'storage_unavailable',
          message: 'Supabase canonical storage is unavailable and no Cloudflare backup storage accepted the snapshot.'
        }, corsOrigin);
      }
      return {
        bytes: snapshotBytes,
        metadata
      };
    }
    await writeSnapshotToCloudflareBackup({
      env,
      userId,
      snapshotJson,
      metadata,
      requestId
    });
    return {
      bytes: snapshotBytes,
      metadata
    };
  }

  const stored = await writeSnapshotToCloudflareBackup({
    env,
    userId,
    snapshotJson,
    metadata,
    requestId
  });
  if (!stored) {
    throw jsonResponse(503, {
      error: 'storage_not_configured',
      message: 'No storage backend is configured. Bind BILM_DB (D1) and/or BILM_DATA (KV).'
    }, corsOrigin);
  }
  return {
    bytes: snapshotBytes,
    metadata
  };
}

async function readSnapshotValue({ env, userId, requestId = '' }) {
  const canonicalConfig = resolveSupabaseCanonicalConfig(env);
  if (isSupabaseCanonicalPrimaryActive(env, canonicalConfig)) {
    const supabaseResult = await readSupabaseSnapshotRow({
      config: canonicalConfig,
      userId,
      requestId
    });
    if (!supabaseResult.ok) {
      const fallbackValue = await readSnapshotValueFromCloudflareBackup({ env, userId });
      if (fallbackValue !== null) {
        logSupabaseFallback(requestId, 'snapshot read', supabaseResult.error || `http_${supabaseResult.status || 0}`);
        return fallbackValue;
      }
      throw new Error(`supabase canonical snapshot read failed: ${supabaseResult.error || 'unknown'}`);
    }
    const payload = parseCanonicalPayloadObject(supabaseResult?.row?.payload_json);
    if (!payload) {
      const fallbackValue = await readSnapshotValueFromCloudflareBackup({ env, userId });
      if (fallbackValue !== null) {
        logSupabaseFallback(requestId, 'snapshot read', 'empty_supabase_row');
        return fallbackValue;
      }
      return null;
    }
    return JSON.stringify(payload);
  }

  return await readSnapshotValueFromCloudflareBackup({ env, userId });
}

async function readSnapshotMeta({ env, userId, requestId = '' }) {
  const canonicalConfig = resolveSupabaseCanonicalConfig(env);
  if (isSupabaseCanonicalPrimaryActive(env, canonicalConfig)) {
    const supabaseResult = await readSupabaseSnapshotRow({
      config: canonicalConfig,
      userId,
      requestId
    });
    if (!supabaseResult.ok) {
      const fallbackMeta = await readSnapshotMetaFromCloudflareBackup({ env, userId });
      if (fallbackMeta.exists) {
        logSupabaseFallback(requestId, 'snapshot metadata read', supabaseResult.error || `http_${supabaseResult.status || 0}`);
        return fallbackMeta;
      }
      throw new Error(`supabase canonical snapshot metadata read failed: ${supabaseResult.error || 'unknown'}`);
    }
    const row = supabaseResult.row;
    const payload = parseCanonicalPayloadObject(row?.payload_json);
    if (!payload) {
      const fallbackMeta = await readSnapshotMetaFromCloudflareBackup({ env, userId });
      if (fallbackMeta.exists) {
        logSupabaseFallback(requestId, 'snapshot metadata read', 'empty_supabase_row');
      }
      return fallbackMeta;
    }
    const metadata = getSnapshotMetadata(payload || {});
    return {
      exists: Boolean(payload),
      updatedAtMs: payload ? Number(row?.updated_at_ms || metadata.updatedAtMs || 0) || null : null,
      deviceId: payload ? String(metadata.deviceId || '').trim() || null : null,
      schema: payload ? String(metadata.schema || '').trim() || null : null
    };
  }

  return await readSnapshotMetaFromCloudflareBackup({ env, userId });
}

function normalizeUpdatedAtMs(value) {
  return clampTimestampMs(value, Date.now());
}

function clampTimestampMs(value, fallback = 0) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Number(fallback || 0) || 0;
  }
  const normalized = Math.floor(parsed);
  const maxFutureMs = Date.now() + SYNC_FUTURE_TIME_WINDOW_MS;
  if (normalized > maxFutureMs) {
    return maxFutureMs;
  }
  return normalized;
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

function buildSectorPullStatement({ db, userId, sinceMs, limit, sectors, cursor = null }) {
  const validSectors = Array.isArray(sectors) ? sectors.filter((sector) => isValidSectorKey(sector)) : [];
  const normalizedCursor = cursor ? normalizeSharedFeedCursor(cursor) : null;
  const bindings = [userId];
  let sql = `${SELECT_SECTOR_SYNC_CHANGES_BASE_SQL}`;
  if (normalizedCursor) {
    bindings.push(
      parseSinceMs(normalizedCursor.updatedAtMs),
      normalizeOperationId(normalizedCursor.opId),
      normalizeSectorKey(normalizedCursor.sectorKey),
      normalizeItemKey(normalizedCursor.itemKey)
    );
    sql += `
    AND (
      updated_at_ms > ?2
      OR (
        updated_at_ms = ?2
        AND (
          COALESCE(op_id, '') > ?3
          OR (
            COALESCE(op_id, '') = ?3
            AND (
              sector_key > ?4
              OR (sector_key = ?4 AND item_key > ?5)
            )
          )
        )
      )
    )`;
  } else {
    bindings.push(sinceMs);
    sql += ` AND updated_at_ms > ?2`;
  }
  if (validSectors.length) {
    const sectorPlaceholderStart = bindings.length + 1;
    const placeholders = validSectors.map((_, index) => `?${sectorPlaceholderStart + index}`).join(', ');
    sql += ` AND sector_key IN (${placeholders})`;
    bindings.push(...validSectors);
  }
  sql += ` ORDER BY updated_at_ms ASC, COALESCE(op_id, '') ASC, sector_key ASC, item_key ASC`;
  sql += ` LIMIT ?${bindings.length + 1}`;
  bindings.push(limit);
  return db.prepare(sql).bind(...bindings);
}

function quotePostgrestFilterValue(value = '') {
  const raw = String(value || '');
  const escaped = raw
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function buildSupabaseSyncCursorFilter(cursor = null) {
  const normalized = cursor ? normalizeSharedFeedCursor(cursor) : null;
  if (!normalized) return null;
  const updatedAtMs = parseSinceMs(normalized.updatedAtMs);
  const opId = normalizeOperationId(normalized.opId);
  const sectorKey = normalizeSectorKey(normalized.sectorKey);
  const itemKey = normalizeItemKey(normalized.itemKey);
  const encodedOpId = quotePostgrestFilterValue(opId);
  const encodedSectorKey = quotePostgrestFilterValue(sectorKey);
  const encodedItemKey = quotePostgrestFilterValue(itemKey);
  const sameOpClauses = opId
    ? [
        `and(updated_at_ms.eq.${updatedAtMs},op_id.gt.${encodedOpId})`,
        `and(updated_at_ms.eq.${updatedAtMs},op_id.eq.${encodedOpId},data_group.gt.${encodedSectorKey})`,
        `and(updated_at_ms.eq.${updatedAtMs},op_id.eq.${encodedOpId},data_group.eq.${encodedSectorKey},data_key.gt.${encodedItemKey})`
      ]
    : [
        `and(updated_at_ms.eq.${updatedAtMs},op_id.is.null,data_group.gt.${encodedSectorKey})`,
        `and(updated_at_ms.eq.${updatedAtMs},op_id.is.null,data_group.eq.${encodedSectorKey},data_key.gt.${encodedItemKey})`,
        `and(updated_at_ms.eq.${updatedAtMs},op_id.gt.${encodedOpId})`
      ];
  return [
    `updated_at_ms.gt.${updatedAtMs}`,
    ...sameOpClauses
  ].join(',');
}

function buildSectorPullCursorFromRow(row = {}) {
  return normalizeSharedFeedCursor({
    updatedAtMs: row?.updated_at_ms,
    opId: row?.op_id,
    sectorKey: row?.sector_key ?? row?.data_group,
    itemKey: row?.item_key ?? row?.data_key
  });
}

function chooseLaterSyncCursor(left = null, right = null) {
  const normalizedLeft = left ? normalizeSharedFeedCursor(left) : null;
  const normalizedRight = right ? normalizeSharedFeedCursor(right) : null;
  if (!normalizedLeft) return normalizedRight;
  if (!normalizedRight) return normalizedLeft;
  return compareSharedFeedTuple(normalizedRight, normalizedLeft) > 0 ? normalizedRight : normalizedLeft;
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
      normalizeUpdatedAtMs(updatedAtMs),
      savedAt
    )
    .run();
}

function parseSinceMs(rawValue) {
  return clampTimestampMs(rawValue, 0);
}

function parsePullLimit(rawValue) {
  const value = Number(rawValue || 250);
  if (!Number.isFinite(value)) return 250;
  return Math.max(1, Math.min(500, Math.floor(value)));
}

function normalizeSharedFeedCursor({
  updatedAtMs = 0,
  opId = '',
  sectorKey = '',
  itemKey = ''
} = {}) {
  const normalizedUpdatedAtMs = parseSinceMs(updatedAtMs);
  const normalizedOpId = normalizeOperationId(opId);
  const normalizedSectorKey = normalizeSectorKey(sectorKey);
  const normalizedItemKey = normalizeItemKey(itemKey);
  const hasCursor = normalizedUpdatedAtMs > 0
    || Boolean(normalizedOpId)
    || Boolean(normalizedSectorKey)
    || Boolean(normalizedItemKey);
  if (!hasCursor) return null;
  return {
    updatedAtMs: normalizedUpdatedAtMs,
    opId: normalizedOpId,
    sectorKey: normalizedSectorKey,
    itemKey: normalizedItemKey
  };
}

function compareSharedFeedTuple(left = {}, right = {}) {
  const leftUpdatedAtMs = parseSinceMs(left?.updatedAtMs);
  const rightUpdatedAtMs = parseSinceMs(right?.updatedAtMs);
  if (leftUpdatedAtMs !== rightUpdatedAtMs) return leftUpdatedAtMs - rightUpdatedAtMs;
  const leftOpId = normalizeOperationId(left?.opId);
  const rightOpId = normalizeOperationId(right?.opId);
  if (leftOpId !== rightOpId) return leftOpId.localeCompare(rightOpId);
  const leftSectorKey = normalizeSectorKey(left?.sectorKey);
  const rightSectorKey = normalizeSectorKey(right?.sectorKey);
  if (leftSectorKey !== rightSectorKey) return leftSectorKey.localeCompare(rightSectorKey);
  const leftItemKey = normalizeItemKey(left?.itemKey);
  const rightItemKey = normalizeItemKey(right?.itemKey);
  if (leftItemKey !== rightItemKey) return leftItemKey.localeCompare(rightItemKey);
  return 0;
}

function buildSharedFeedCursorFromOperation(operation = {}) {
  return {
    updatedAtMs: parseSinceMs(operation?.updatedAtMs),
    opId: normalizeOperationId(operation?.opId),
    sectorKey: normalizeSectorKey(operation?.sectorKey),
    itemKey: normalizeItemKey(operation?.itemKey)
  };
}

function buildSharedSyncItemsStatement({ db, userId, sinceMs, sectors, limit, cursor = null }) {
  const validSectors = Array.isArray(sectors)
    ? [...new Set(sectors.map((sector) => normalizeSectorKey(sector)).filter((sector) => isValidSectorKey(sector)))]
    : [];
  if (!validSectors.length) return null;
  const bindings = [userId];
  let sql = `${SELECT_SHARED_SYNC_ITEMS_BASE_SQL}`;
  if (cursor) {
    bindings.push(
      parseSinceMs(cursor.updatedAtMs),
      normalizeOperationId(cursor.opId),
      normalizeSectorKey(cursor.sectorKey),
      normalizeItemKey(cursor.itemKey)
    );
    sql += `
      AND (
        updated_at_ms > ?2
        OR (
          updated_at_ms = ?2
          AND (
            COALESCE(op_id, '') > ?3
            OR (
              COALESCE(op_id, '') = ?3
              AND (
                sector_key > ?4
                OR (sector_key = ?4 AND item_key > ?5)
              )
            )
          )
        )
      )`;
  } else {
    bindings.push(sinceMs);
    sql += ` AND updated_at_ms > ?2`;
  }
  const sectorPlaceholderStart = bindings.length + 1;
  const placeholders = validSectors.map((_, index) => `?${sectorPlaceholderStart + index}`).join(', ');
  sql += ` AND sector_key IN (${placeholders})`;
  sql += ` ORDER BY updated_at_ms ASC, COALESCE(op_id, '') ASC, sector_key ASC, item_key ASC`;
  sql += ` LIMIT ?${sectorPlaceholderStart + validSectors.length}`;
  bindings.push(...validSectors, limit);
  return db.prepare(sql).bind(...bindings);
}

async function handleListAccountLinks({ request, env, corsOrigin, verifyIdToken, requestId }) {
  assertD1Configured(env, corsOrigin);
  const url = new URL(request.url);
  const userId = normalizeUserId(url.searchParams.get('userId'));
  const authContext = await requireAccountLinkAuthContext({
    request,
    env,
    corsOrigin,
    verifyIdToken,
    userId,
    requestId
  });
  enforceAccountLinkRateLimit({ env, authContext, corsOrigin, requestId, kind: 'read' });
  const db = getD1Database(env);
  await upsertAccountUserCapability({
    db,
    userId: authContext.userId,
    email: authContext.email
  });

  const linkRows = await listAccountLinksForActor({
    db,
    userId: authContext.userId,
    email: authContext.email
  });
  const links = [];
  for (const row of linkRows) {
    links.push(await expireAccountLinkIfNeeded({ db, link: row }));
  }
  const formatted = links.map((row) => formatAccountLinkForActor(row, authContext.userId, authContext.email));
  const activeLink = formatted.find((link) => link?.status === ACCOUNT_LINK_STATUS_ACTIVE) || null;
  const incomingRequests = formatted.filter((link) => link?.status === ACCOUNT_LINK_STATUS_PENDING && link.canApprove);
  const pendingRequests = formatted.filter((link) => link?.status === ACCOUNT_LINK_STATUS_PENDING);

  return jsonResponse(200, {
    ok: true,
    links: formatted,
    activeLink,
    incomingRequests,
    pendingRequests
  }, corsOrigin, { 'x-request-id': requestId });
}

async function handleGetAccountLinkTargetCapabilities({ request, env, corsOrigin, verifyIdToken, requestId }) {
  assertD1Configured(env, corsOrigin);
  const url = new URL(request.url);
  const userId = normalizeUserId(url.searchParams.get('userId'));
  const authContext = await requireAccountLinkAuthContext({
    request,
    env,
    corsOrigin,
    verifyIdToken,
    userId,
    requestId
  });
  enforceAccountLinkRateLimit({ env, authContext, corsOrigin, requestId, kind: 'read' });
  const db = getD1Database(env);
  await upsertAccountUserCapability({
    db,
    userId: authContext.userId,
    email: authContext.email
  });

  const targetEmail = canonicalizeEmailForMatching(url.searchParams.get('email'));
  if (!isValidEmail(targetEmail)) {
    return errorResponse(400, {
      error: 'invalid_target_email',
      message: 'A valid target email is required.',
      retryable: false,
      code: 'invalid_target_email',
      requestId
    }, corsOrigin);
  }
  if (emailsLikelySameAccount(targetEmail, authContext.email)) {
    return errorResponse(400, {
      error: 'self_link_forbidden',
      message: 'You cannot link your account to itself.',
      retryable: false,
      code: 'self_link_forbidden',
      requestId
    }, corsOrigin);
  }

  const requesterBlocking = await findBlockingAccountLink({
    db,
    userId: authContext.userId,
    email: authContext.email
  });
  const targetCapability = await readAccountUserCapabilityByEmail({
    db,
    email: targetEmail
  });
  const resolvedTargetUserId = normalizeUserId(targetCapability?.userId);
  const resolvedTargetEmail = canonicalizeEmailForMatching(targetCapability?.email || targetEmail) || targetEmail;
  const accountFound = Boolean(resolvedTargetUserId);
  const targetBlocking = await findBlockingAccountLink({
    db,
    userId: resolvedTargetUserId,
    email: resolvedTargetEmail
  });

  return jsonResponse(200, {
    ok: true,
    targetEmail,
    accountFound,
    requesterBlocked: Boolean(requesterBlocking),
    targetBlocked: Boolean(targetBlocking),
    canRequest: !requesterBlocking && !targetBlocking
  }, corsOrigin, { 'x-request-id': requestId });
}

async function handleCreateAccountLinkRequest({ request, env, corsOrigin, verifyIdToken, requestId, executionContext = null }) {
  assertD1Configured(env, corsOrigin);
  const body = await parseJsonBody(request, corsOrigin, requestId);
  const userId = normalizeUserId(body?.userId);
  const authContext = await requireAccountLinkAuthContext({
    request,
    env,
    corsOrigin,
    verifyIdToken,
    userId,
    requestId
  });
  enforceAccountLinkRateLimit({ env, authContext, corsOrigin, requestId, kind: 'mutation' });
  const targetEmail = canonicalizeEmailForMatching(body?.targetEmail);
  if (!isValidEmail(targetEmail)) {
    return errorResponse(400, {
      error: 'invalid_target_email',
      message: 'A valid target email is required.',
      retryable: false,
      code: 'invalid_target_email',
      requestId
    }, corsOrigin);
  }
  if (emailsLikelySameAccount(targetEmail, authContext.email)) {
    return errorResponse(400, {
      error: 'self_link_forbidden',
      message: 'You cannot link your account to itself.',
      retryable: false,
      code: 'self_link_forbidden',
      requestId
    }, corsOrigin);
  }

  const requesterShareScopes = normalizeAccountLinkScopes(body?.shareScopes);
  if (!hasAnyEnabledAccountLinkScope(requesterShareScopes)) {
    return errorResponse(400, {
      error: 'invalid_share_scopes',
      message: 'Choose at least one category to share.',
      retryable: false,
      code: 'invalid_share_scopes',
      requestId
    }, corsOrigin);
  }

  const db = getD1Database(env);
  await upsertAccountUserCapability({
    db,
    userId: authContext.userId,
    email: authContext.email
  });

  const requesterBlocking = await findBlockingAccountLink({
    db,
    userId: authContext.userId,
    email: authContext.email
  });
  if (requesterBlocking) {
    return errorResponse(409, {
      error: 'link_conflict',
      message: 'You already have a pending or active account link. Unlink it first.',
      retryable: false,
      code: 'requester_link_conflict',
      requestId
    }, corsOrigin);
  }

  const targetCapability = await readAccountUserCapabilityByEmail({
    db,
    email: targetEmail
  });
  const resolvedTargetUserId = normalizeUserId(targetCapability?.userId);
  const canonicalTargetEmail = canonicalizeEmailForMatching(targetCapability?.email || targetEmail);
  const targetBlocking = await findBlockingAccountLink({
    db,
    userId: resolvedTargetUserId,
    email: canonicalTargetEmail || targetEmail
  });
  if (targetBlocking) {
    return errorResponse(409, {
      error: 'target_link_conflict',
      message: 'That account cannot receive a new link request right now.',
      retryable: false,
      code: 'target_link_conflict',
      requestId
    }, corsOrigin);
  }

  const nowMs = Date.now();
  const link = {
    id: createAccountLinkId(),
    status: ACCOUNT_LINK_STATUS_PENDING,
    requesterUserId: authContext.userId,
    requesterEmail: authContext.email,
    targetUserId: resolvedTargetUserId || null,
    targetEmail: canonicalTargetEmail || targetEmail,
    requesterShareScopes,
    targetShareScopes: { ...DEFAULT_ACCOUNT_LINK_SCOPES },
    requesterApprovedAtMs: nowMs,
    targetApprovedAtMs: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    activatedAtMs: null,
    declinedAtMs: null,
    unlinkedAtMs: null
  };
  await db.prepare(INSERT_ACCOUNT_LINK_SQL).bind(
    link.id,
    link.status,
    link.requesterUserId,
    link.requesterEmail,
    link.targetUserId,
    link.targetEmail,
    JSON.stringify(link.requesterShareScopes),
    JSON.stringify(link.targetShareScopes),
    link.requesterApprovedAtMs,
    link.targetApprovedAtMs,
    link.createdAtMs,
    link.updatedAtMs,
    link.activatedAtMs,
    link.declinedAtMs,
    link.unlinkedAtMs
  ).run();

  const saved = await readAccountLinkById({ db, linkId: link.id });
  const responsePayload = {
    ok: true,
    accountFound: Boolean(resolvedTargetUserId),
    link: formatAccountLinkForActor(saved || link, authContext.userId, authContext.email)
  };
  queueSupabaseMirrorWrite({
    executionContext,
    env,
    path: '/links/request',
    method: request.method,
    userId: authContext.userId,
    requestId,
    requestBody: body,
    responseBody: responsePayload,
    status: 200
  });
  return jsonResponse(200, responsePayload, corsOrigin, { 'x-request-id': requestId });
}

async function handleRespondToAccountLinkRequest({ request, env, corsOrigin, verifyIdToken, requestId, executionContext = null }) {
  assertD1Configured(env, corsOrigin);
  const body = await parseJsonBody(request, corsOrigin, requestId);
  const userId = normalizeUserId(body?.userId);
  const authContext = await requireAccountLinkAuthContext({
    request,
    env,
    corsOrigin,
    verifyIdToken,
    userId,
    requestId
  });
  enforceAccountLinkRateLimit({ env, authContext, corsOrigin, requestId, kind: 'mutation' });
  const linkId = String(body?.linkId || '').trim();
  const action = String(body?.action || '').trim().toLowerCase();
  if (!linkId) {
    return errorResponse(400, {
      error: 'invalid_link_id',
      message: 'linkId is required.',
      retryable: false,
      code: 'invalid_link_id',
      requestId
    }, corsOrigin);
  }
  if (action !== 'approve' && action !== 'decline') {
    return errorResponse(400, {
      error: 'invalid_action',
      message: 'action must be "approve" or "decline".',
      retryable: false,
      code: 'invalid_action',
      requestId
    }, corsOrigin);
  }

  const db = getD1Database(env);
  await upsertAccountUserCapability({
    db,
    userId: authContext.userId,
    email: authContext.email
  });

  let existing = await readAccountLinkById({ db, linkId });
  if (!existing) {
    return errorResponse(404, {
      error: 'link_not_found',
      message: 'Account link request not found.',
      retryable: false,
      code: 'link_not_found',
      requestId
    }, corsOrigin);
  }
  const role = getAccountLinkRole({
    requester_user_id: existing.requesterUserId,
    requester_email: existing.requesterEmail,
    target_user_id: existing.targetUserId,
    target_email: existing.targetEmail
  }, authContext.userId, authContext.email);
  if (role !== 'target') {
    return errorResponse(403, {
      error: 'forbidden',
      message: 'Only the invited account can approve or decline this request.',
      retryable: false,
      code: 'forbidden',
      requestId
    }, corsOrigin);
  }
  existing = await expireAccountLinkIfNeeded({ db, link: existing });
  if (existing.status !== ACCOUNT_LINK_STATUS_PENDING) {
    return errorResponse(409, {
      error: 'link_not_pending',
      message: 'This account link request is no longer pending.',
      retryable: false,
      code: 'link_not_pending',
      requestId
    }, corsOrigin);
  }

  const nowMs = Date.now();
  const next = {
    ...existing,
    targetUserId: authContext.userId,
    targetEmail: authContext.email,
    updatedAtMs: nowMs
  };

  if (action === 'decline') {
    next.status = ACCOUNT_LINK_STATUS_DECLINED;
    next.targetApprovedAtMs = null;
    next.declinedAtMs = nowMs;
  } else {
    const shareScopes = normalizeAccountLinkScopes(body?.shareScopes);
    next.targetShareScopes = shareScopes;
    next.targetApprovedAtMs = nowMs;
    next.declinedAtMs = null;
    next.status = ACCOUNT_LINK_STATUS_ACTIVE;
    next.activatedAtMs = nowMs;

    const requesterBlocking = await findBlockingAccountLink({
      db,
      userId: next.requesterUserId,
      email: next.requesterEmail,
      excludeLinkId: next.id
    });
    if (requesterBlocking) {
      return errorResponse(409, {
        error: 'requester_link_conflict',
        message: 'The requester account already has another pending or active link.',
        retryable: false,
        code: 'requester_link_conflict',
        requestId
      }, corsOrigin);
    }
    const targetBlocking = await findBlockingAccountLink({
      db,
      userId: next.targetUserId,
      email: next.targetEmail,
      excludeLinkId: next.id
    });
    if (targetBlocking) {
      return errorResponse(409, {
        error: 'target_link_conflict',
        message: 'This account cannot approve a new link right now.',
        retryable: false,
        code: 'target_link_conflict',
        requestId
      }, corsOrigin);
    }
  }

  await saveAccountLinkRow({ db, link: next });
  const saved = await readAccountLinkById({ db, linkId: next.id });
  const responsePayload = {
    ok: true,
    link: formatAccountLinkForActor(saved || next, authContext.userId, authContext.email)
  };
  queueSupabaseMirrorWrite({
    executionContext,
    env,
    path: '/links/respond',
    method: request.method,
    userId: authContext.userId,
    requestId,
    requestBody: body,
    responseBody: responsePayload,
    status: 200
  });
  return jsonResponse(200, responsePayload, corsOrigin, { 'x-request-id': requestId });
}

async function handleUpdateAccountLinkScopes({ request, env, corsOrigin, verifyIdToken, requestId, executionContext = null }) {
  assertD1Configured(env, corsOrigin);
  const body = await parseJsonBody(request, corsOrigin, requestId);
  const userId = normalizeUserId(body?.userId);
  const authContext = await requireAccountLinkAuthContext({
    request,
    env,
    corsOrigin,
    verifyIdToken,
    userId,
    requestId
  });
  enforceAccountLinkRateLimit({ env, authContext, corsOrigin, requestId, kind: 'mutation' });
  const linkId = String(body?.linkId || '').trim();
  if (!linkId) {
    return errorResponse(400, {
      error: 'invalid_link_id',
      message: 'linkId is required.',
      retryable: false,
      code: 'invalid_link_id',
      requestId
    }, corsOrigin);
  }

  const db = getD1Database(env);
  const existing = await readAccountLinkById({ db, linkId });
  if (!existing) {
    return errorResponse(404, {
      error: 'link_not_found',
      message: 'Account link not found.',
      retryable: false,
      code: 'link_not_found',
      requestId
    }, corsOrigin);
  }
  const role = getAccountLinkRole({
    requester_user_id: existing.requesterUserId,
    requester_email: existing.requesterEmail,
    target_user_id: existing.targetUserId,
    target_email: existing.targetEmail
  }, authContext.userId, authContext.email);
  if (!role) {
    return errorResponse(403, {
      error: 'forbidden',
      message: 'You are not part of this account link.',
      retryable: false,
      code: 'forbidden',
      requestId
    }, corsOrigin);
  }
  if (existing.status !== ACCOUNT_LINK_STATUS_ACTIVE) {
    return errorResponse(409, {
      error: 'link_not_active',
      message: 'Sharing settings can only be updated on an active link.',
      retryable: false,
      code: 'link_not_active',
      requestId
    }, corsOrigin);
  }

  const next = {
    ...existing,
    updatedAtMs: Date.now()
  };
  const normalizedScopes = normalizeAccountLinkScopes(body?.shareScopes);
  if (role === 'requester') {
    next.requesterShareScopes = normalizedScopes;
  } else {
    next.targetShareScopes = normalizedScopes;
  }

  await saveAccountLinkRow({ db, link: next });
  const saved = await readAccountLinkById({ db, linkId: next.id });
  const responsePayload = {
    ok: true,
    link: formatAccountLinkForActor(saved || next, authContext.userId, authContext.email)
  };
  queueSupabaseMirrorWrite({
    executionContext,
    env,
    path: '/links/scopes',
    method: request.method,
    userId: authContext.userId,
    requestId,
    requestBody: body,
    responseBody: responsePayload,
    status: 200
  });
  return jsonResponse(200, responsePayload, corsOrigin, { 'x-request-id': requestId });
}

async function handleUnlinkAccountLink({ request, env, corsOrigin, verifyIdToken, requestId, executionContext = null }) {
  assertD1Configured(env, corsOrigin);
  const body = await parseJsonBody(request, corsOrigin, requestId);
  const userId = normalizeUserId(body?.userId);
  const authContext = await requireAccountLinkAuthContext({
    request,
    env,
    corsOrigin,
    verifyIdToken,
    userId,
    requestId
  });
  enforceAccountLinkRateLimit({ env, authContext, corsOrigin, requestId, kind: 'mutation' });
  const linkId = String(body?.linkId || '').trim();
  if (!linkId) {
    return errorResponse(400, {
      error: 'invalid_link_id',
      message: 'linkId is required.',
      retryable: false,
      code: 'invalid_link_id',
      requestId
    }, corsOrigin);
  }

  const db = getD1Database(env);
  const existing = await readAccountLinkById({ db, linkId });
  if (!existing) {
    return errorResponse(404, {
      error: 'link_not_found',
      message: 'Account link not found.',
      retryable: false,
      code: 'link_not_found',
      requestId
    }, corsOrigin);
  }
  if (!isAccountLinkParticipant({
    requester_user_id: existing.requesterUserId,
    requester_email: existing.requesterEmail,
    target_user_id: existing.targetUserId,
    target_email: existing.targetEmail
  }, authContext.userId, authContext.email)) {
    return errorResponse(403, {
      error: 'forbidden',
      message: 'You are not part of this account link.',
      retryable: false,
      code: 'forbidden',
      requestId
    }, corsOrigin);
  }

  const next = {
    ...existing,
    status: ACCOUNT_LINK_STATUS_UNLINKED,
    updatedAtMs: Date.now(),
    unlinkedAtMs: Date.now()
  };
  await saveAccountLinkRow({ db, link: next });
  const responsePayload = {
    ok: true,
    link: formatAccountLinkForActor(next, authContext.userId, authContext.email)
  };
  queueSupabaseMirrorWrite({
    executionContext,
    env,
    path: '/links/unlink',
    method: request.method,
    userId: authContext.userId,
    requestId,
    requestBody: body,
    responseBody: responsePayload,
    status: 200
  });
  return jsonResponse(200, responsePayload, corsOrigin, { 'x-request-id': requestId });
}

async function handleMarkAccountChatReady({ request, env, corsOrigin, verifyIdToken, requestId, executionContext = null }) {
  assertD1Configured(env, corsOrigin);
  const body = await parseJsonBody(request, corsOrigin, requestId);
  const userId = normalizeUserId(body?.userId);
  const authContext = await requireAccountLinkAuthContext({
    request,
    env,
    corsOrigin,
    verifyIdToken,
    userId,
    requestId
  });
  enforceAccountLinkRateLimit({ env, authContext, corsOrigin, requestId, kind: 'mutation' });
  const responsePayload = {
    ok: true,
    deprecated: true,
    userId: authContext.userId,
    chatReady: false
  };
  queueSupabaseMirrorWrite({
    executionContext,
    env,
    path: '/links/chat-ready',
    method: request.method,
    userId: authContext.userId,
    requestId,
    requestBody: body,
    responseBody: responsePayload,
    status: 200
  });
  return jsonResponse(200, responsePayload, corsOrigin, { 'x-request-id': requestId });
}

async function handleResetAccountData({ request, env, corsOrigin, verifyIdToken, requestId, executionContext = null }) {
  const canonicalConfig = resolveSupabaseCanonicalConfig(env);
  const supabasePrimaryActive = isSupabaseCanonicalPrimaryActive(env, canonicalConfig);
  if (!supabasePrimaryActive) {
    assertStorageConfigured(env, corsOrigin);
  }
  const body = await parseJsonBody(request, corsOrigin, requestId);
  const url = new URL(request.url);
  const userId = normalizeUserId(body?.userId || url.searchParams.get('userId'));
  const authContext = await requireAccountLinkAuthContext({
    request,
    env,
    corsOrigin,
    verifyIdToken,
    userId,
    requestId
  });
  enforcePrivateEndpointRateLimit({
    env,
    userId: authContext.userId,
    corsOrigin,
    requestId,
    kind: 'snapshotWrite'
  });

  const canonicalEmail = canonicalizeEmailForMatching(authContext.email);
  const db = getD1Database(env);
  const deleted = {
    snapshots: 0,
    sectorSyncItems: 0,
    listSyncItems: 0,
    syncState: 0,
    accountLinks: 0,
    accountCapabilities: 0,
    kvSnapshots: 0,
    supabaseRowsMarked: 0
  };

  if (db) {
    const snapshotDeleteResult = await db.prepare(DELETE_SNAPSHOT_FOR_USER_SQL).bind(authContext.userId).run();
    deleted.snapshots = Number(snapshotDeleteResult?.meta?.changes || 0) || 0;

    const sectorDeleteResult = await db.prepare(DELETE_SECTOR_SYNC_ITEMS_FOR_USER_SQL).bind(authContext.userId).run();
    deleted.sectorSyncItems = Number(sectorDeleteResult?.meta?.changes || 0) || 0;

    const listDeleteResult = await db.prepare(DELETE_LIST_SYNC_ITEMS_FOR_USER_SQL).bind(authContext.userId).run();
    deleted.listSyncItems = Number(listDeleteResult?.meta?.changes || 0) || 0;

    const syncStateDeleteResult = await db.prepare(DELETE_USER_SYNC_STATE_FOR_USER_SQL).bind(authContext.userId).run();
    deleted.syncState = Number(syncStateDeleteResult?.meta?.changes || 0) || 0;

    const linkDeleteResult = await db
      .prepare(DELETE_ACCOUNT_LINKS_FOR_USER_SQL)
      .bind(authContext.userId, canonicalEmail)
      .run();
    deleted.accountLinks = Number(linkDeleteResult?.meta?.changes || 0) || 0;

    const capabilityDeleteResult = await db
      .prepare(DELETE_ACCOUNT_USER_CAPABILITY_FOR_USER_SQL)
      .bind(authContext.userId, canonicalEmail)
      .run();
    deleted.accountCapabilities = Number(capabilityDeleteResult?.meta?.changes || 0) || 0;
  }

  const kv = getKvNamespace(env);
  if (kv) {
    if (typeof kv.delete === 'function') {
      await kv.delete(`user-${authContext.userId}`);
      deleted.kvSnapshots = 1;
    } else if (typeof kv.put === 'function') {
      await kv.put(`user-${authContext.userId}`, '', { expirationTtl: 1 });
      deleted.kvSnapshots = 1;
    }
  }

  if (supabasePrimaryActive) {
    const deleteMarkResult = await markSupabaseCanonicalRowsDeletedForUser({
      config: canonicalConfig,
      userId: authContext.userId,
      deletedAtMs: Date.now(),
      requestId,
      sourcePath: '/account/reset'
    });
    if (!deleteMarkResult.ok) {
      return errorResponse(503, {
        error: 'storage_unavailable',
        message: 'Supabase canonical storage is unavailable. Please retry shortly.',
        retryable: true,
        code: 'storage_unavailable',
        requestId
      }, corsOrigin);
    }
    deleted.supabaseRowsMarked = 1;
    const stateWriteResult = await persistSupabaseSyncState({
      config: canonicalConfig,
      userId: authContext.userId,
      state: {
        migratedAtMs: null,
        migrationSource: null,
        updatedAtMs: Date.now()
      },
      requestId,
      sourcePath: '/account/reset'
    });
    if (!stateWriteResult.ok) {
      return errorResponse(503, {
        error: 'storage_unavailable',
        message: 'Supabase canonical storage is unavailable. Please retry shortly.',
        retryable: true,
        code: 'storage_unavailable',
        requestId
      }, corsOrigin);
    }
  }

  const responsePayload = {
    ok: true,
    userId: authContext.userId,
    email: canonicalEmail,
    deleted
  };
  queueSupabaseMirrorWrite({
    executionContext,
    env,
    path: '/account/reset',
    method: request.method,
    userId: authContext.userId,
    requestId,
    requestBody: body,
    responseBody: responsePayload,
    status: 200
  });
  return jsonResponse(200, responsePayload, corsOrigin, { 'x-request-id': requestId });
}

async function handlePullLinkedSharedFeed({ request, env, corsOrigin, verifyIdToken, requestId }) {
  assertD1Configured(env, corsOrigin);
  const url = new URL(request.url);
  const userId = normalizeUserId(url.searchParams.get('userId'));
  const authContext = await requireAccountLinkAuthContext({
    request,
    env,
    corsOrigin,
    verifyIdToken,
    userId,
    requestId
  });
  enforceAccountLinkRateLimit({ env, authContext, corsOrigin, requestId, kind: 'read' });
  const sinceMs = parseSinceMs(url.searchParams.get('since'));
  const cursor = normalizeSharedFeedCursor({
    updatedAtMs: url.searchParams.get('cursorUpdatedAtMs'),
    opId: url.searchParams.get('cursorOpId'),
    sectorKey: url.searchParams.get('cursorSectorKey'),
    itemKey: url.searchParams.get('cursorItemKey')
  });
  const limit = parsePullLimit(url.searchParams.get('limit'));
  const db = getD1Database(env);

  await upsertAccountUserCapability({
    db,
    userId: authContext.userId,
    email: authContext.email
  });
  const links = await listAccountLinksForActor({
    db,
    userId: authContext.userId,
    email: authContext.email
  });
  const activeLinks = links.filter((link) => link.status === ACCOUNT_LINK_STATUS_ACTIVE);
  const activeLinkIds = activeLinks
    .map((link) => String(link?.id || '').trim())
    .filter(Boolean)
    .sort();

  const operations = [];
  let hasAdditionalResults = false;
  const linkSignatureParts = [];

  for (const link of activeLinks) {
    const role = getAccountLinkRole({
      requester_user_id: link.requesterUserId,
      requester_email: link.requesterEmail,
      target_user_id: link.targetUserId,
      target_email: link.targetEmail
    }, authContext.userId, authContext.email);
    if (!role) continue;
    const sourceUserId = role === 'requester' ? link.targetUserId : link.requesterUserId;
    const sourceEmail = role === 'requester' ? link.targetEmail : link.requesterEmail;
    const sourceScopes = role === 'requester' ? link.targetShareScopes : link.requesterShareScopes;
    const sectors = getEnabledSharedSectorsFromScopes(sourceScopes);
    linkSignatureParts.push([
      String(link.id || '').trim(),
      String(link.updatedAtMs || 0),
      String(sourceUserId || '').trim(),
      sectors.slice().sort().join(',')
    ].join(':'));
    if (!sourceUserId || !sectors.length) continue;

    const statement = buildSharedSyncItemsStatement({
      db,
      userId: sourceUserId,
      sinceMs,
      sectors,
      limit: limit + 1,
      cursor
    });
    if (!statement) continue;
    const query = await statement.all();
    const rawRows = Array.isArray(query?.results) ? query.results : [];
    const rows = rawRows.slice(0, limit);
    if (rawRows.length > rows.length) {
      hasAdditionalResults = true;
    }
    rows.forEach((row) => {
      const updatedAtMs = parseSinceMs(row?.updated_at_ms);
      const sectorKey = normalizeSectorKey(row?.sector_key);
      const itemKey = normalizeItemKey(row?.item_key);
      if (!isValidSectorKey(sectorKey) || !itemKey) return;
      const deleted = Number(row?.deleted_at_ms || 0) > 0;
      let payload = null;
      if (!deleted) {
        try {
          payload = JSON.parse(String(row?.item_json || 'null'));
        } catch {
          payload = null;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
      }
      operations.push({
        linkId: link.id,
        sourceUserId,
        sourceEmail: sourceEmail || null,
        sectorKey,
        itemKey,
        deleted,
        updatedAtMs,
        opId: String(row?.op_id || '').trim() || null,
        payload
      });
    });
  }

  operations.sort((left, right) => {
    const tupleCompare = compareSharedFeedTuple(
      buildSharedFeedCursorFromOperation(left),
      buildSharedFeedCursorFromOperation(right)
    );
    if (tupleCompare !== 0) return tupleCompare;
    const leftLinkId = String(left?.linkId || '').trim();
    const rightLinkId = String(right?.linkId || '').trim();
    if (leftLinkId !== rightLinkId) return leftLinkId.localeCompare(rightLinkId);
    const leftSourceUserId = String(left?.sourceUserId || '').trim();
    const rightSourceUserId = String(right?.sourceUserId || '').trim();
    return leftSourceUserId.localeCompare(rightSourceUserId);
  });
  const limited = operations.slice(0, limit);
  const fallbackCursor = cursor || {
    updatedAtMs: sinceMs,
    opId: '',
    sectorKey: '',
    itemKey: ''
  };
  const nextCursor = limited.length
    ? buildSharedFeedCursorFromOperation(limited[limited.length - 1])
    : fallbackCursor;
  const hasMore = hasAdditionalResults || operations.length > limited.length;

  return jsonResponse(200, {
    ok: true,
    sinceMs,
    cursorMs: parseSinceMs(nextCursor.updatedAtMs),
    cursorUpdatedAtMs: parseSinceMs(nextCursor.updatedAtMs),
    cursorOpId: normalizeOperationId(nextCursor.opId),
    cursorSectorKey: normalizeSectorKey(nextCursor.sectorKey),
    cursorItemKey: normalizeItemKey(nextCursor.itemKey),
    hasMore,
    activeLinkIds,
    linkSignature: linkSignatureParts.sort().join('|'),
    operations: limited
  }, corsOrigin, { 'x-request-id': requestId });
}

async function handleListSyncPush({ request, env, corsOrigin, verifyIdToken, requestId, executionContext = null }) {
  const canonicalConfig = resolveSupabaseCanonicalConfig(env);
  const supabasePrimaryActive = isSupabaseCanonicalPrimaryActive(env, canonicalConfig);
  if (!supabasePrimaryActive) {
    assertD1Configured(env, corsOrigin);
  }
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

  const authPayload = await requireSnapshotAuth({ request, corsOrigin, env, verifyIdToken, userId, requestId });
  const authEmail = canonicalizeEmailForMatching(authPayload?.email || '');
  enforcePrivateEndpointRateLimit({ env, userId, corsOrigin, requestId, kind: 'syncWrite' });

  const operations = Array.isArray(body?.operations) ? body.operations : [];
  if (!operations.length) {
    const responsePayload = { ok: true, processed: 0, cursorMs: parseSinceMs(body?.cursorMs) };
    queueSupabaseMirrorWrite({
      executionContext,
      env,
      path: '/sync/lists/push',
      method: request.method,
      userId,
      requestId,
      requestBody: body,
      responseBody: responsePayload,
      status: 200
    });
    return jsonResponse(200, responsePayload, corsOrigin, { 'x-request-id': requestId });
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

  let cursorMs = parseSinceMs(body?.cursorMs);
  let processed = 0;
  if (supabasePrimaryActive) {
    const nowMs = Date.now();
    const rows = [];
    const backupOperations = [];
    const groups = new Set();
    for (let index = 0; index < operations.length; index += 1) {
      const operation = normalizeListSyncOperation(operations[index], corsOrigin, index);
      rows.push(createCanonicalUserDataRow({
        userId,
        scope: 'list',
        group: operation.listKey,
        key: operation.itemKey,
        payload: operation.payload,
        updatedAtMs: operation.updatedAtMs || nowMs,
        deletedAtMs: operation.deleted ? operation.updatedAtMs : null,
        sourcePath: '/sync/lists/push',
        requestId
      }));
      backupOperations.push(operation);
      groups.add(operation.listKey);
      processed += 1;
      if (operation.updatedAtMs > cursorMs) {
        cursorMs = operation.updatedAtMs;
      }
    }
    const supabaseResult = await upsertSupabaseCanonicalOperations({
      config: canonicalConfig,
      userId,
      scope: 'list',
      sourcePath: '/sync/lists/push',
      requestId,
      operations: rows,
      groups: [...groups],
      email: isValidEmail(authEmail) ? authEmail : null
    });
    if (!supabaseResult.ok) {
      logSupabaseFallback(requestId, 'list sync write', supabaseResult.error || `http_${supabaseResult.status || 0}`);
      const backupStored = await tryWriteListSyncOperationsToD1Backup({
        env,
        userId,
        deviceId: body?.deviceId,
        operations: backupOperations
      }, requestId);
      if (!backupStored) {
        return errorResponse(503, {
          error: 'storage_unavailable',
          message: 'Supabase canonical storage is unavailable and Cloudflare D1 backup storage is not configured.',
          retryable: true,
          code: 'storage_unavailable',
          requestId
        }, corsOrigin);
      }
    } else {
      await tryWriteListSyncOperationsToD1Backup({
        env,
        userId,
        deviceId: body?.deviceId,
        operations: backupOperations
      }, requestId);
    }
  } else {
    const db = getD1Database(env);
    const deviceId = String(body?.deviceId || '').trim() || null;
    const nowIso = new Date().toISOString();
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
  }

  const responsePayload = { ok: true, processed, cursorMs };
  queueSupabaseMirrorWrite({
    executionContext,
    env,
    path: '/sync/lists/push',
    method: request.method,
    userId,
    requestId,
    requestBody: body,
    responseBody: responsePayload,
    status: 200
  });
  return jsonResponse(200, responsePayload, corsOrigin, { 'x-request-id': requestId });
}

async function handleListSyncPull({ request, env, corsOrigin, verifyIdToken, requestId }) {
  const canonicalConfig = resolveSupabaseCanonicalConfig(env);
  const supabasePrimaryActive = isSupabaseCanonicalPrimaryActive(env, canonicalConfig);
  if (!supabasePrimaryActive) {
    assertD1Configured(env, corsOrigin);
  }
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
  enforcePrivateEndpointRateLimit({ env, userId, corsOrigin, requestId, kind: 'syncRead' });

  const sinceMs = parseSinceMs(url.searchParams.get('since'));
  const limit = parsePullLimit(url.searchParams.get('limit'));
  let rows = [];
  if (supabasePrimaryActive) {
    const cooldownState = getSupabaseCanonicalReadCooldownState(userId);
    let supabaseQuery = null;
    if (!cooldownState.blocked) {
      supabaseQuery = await selectSupabaseCanonicalRows({
        config: canonicalConfig,
        table: canonicalConfig.userDataTable,
        select: 'data_group,data_key,payload_json,updated_at_ms,deleted_at_ms',
        searchParams: {
          user_id: `eq.${userId}`,
          data_scope: 'eq.list',
          updated_at_ms: `gt.${sinceMs}`
        },
        order: 'updated_at_ms.asc',
        limit,
        requestId
      });
    }
    if (supabaseQuery?.ok) {
      clearSupabaseCanonicalReadCooldown(userId);
      rows = supabaseQuery.rows;
    } else {
      const retryAfterSeconds = supabaseQuery
        ? recordSupabaseCanonicalReadCooldown({ env, userId, status: supabaseQuery.status })
        : cooldownState.retryAfterSeconds;
      const backupRows = await readListSyncRowsFromD1Backup({ env, userId, sinceMs, limit });
      if (backupRows) {
        logSupabaseFallback(
          requestId,
          'list sync read',
          supabaseQuery ? (supabaseQuery.error || `http_${supabaseQuery.status || 0}`) : 'read_cooldown'
        );
        rows = backupRows;
      } else {
        enforceSupabaseCanonicalReadCooldown({ env, userId, corsOrigin, requestId });
        const retryHeaders = retryAfterSeconds > 0 ? { 'retry-after': String(retryAfterSeconds) } : undefined;
        return errorResponse(503, {
          error: 'storage_unavailable',
          message: 'Supabase canonical storage is unavailable and Cloudflare D1 backup storage is not configured.',
          retryable: true,
          code: 'storage_unavailable',
          requestId
        }, corsOrigin, retryHeaders);
      }
    }
  } else {
    rows = await readListSyncRowsFromD1Backup({ env, userId, sinceMs, limit }) || [];
  }

  let cursorMs = sinceMs;
  const operations = [];

  rows.forEach((row) => {
    const updatedAtMs = parseSinceMs(row?.updated_at_ms);
    if (updatedAtMs > cursorMs) {
      cursorMs = updatedAtMs;
    }
    const listKey = normalizeListKey(row?.list_key ?? row?.data_group);
    const itemKey = normalizeItemKey(row?.item_key ?? row?.data_key);
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

    const payload = parseCanonicalPayloadObject(row?.item_json ?? row?.payload_json);
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
  }, corsOrigin, { 'x-request-id': requestId });
}

async function handleSectorSyncPush({ request, env, corsOrigin, verifyIdToken, requestId, executionContext = null }) {
  const canonicalConfig = resolveSupabaseCanonicalConfig(env);
  const supabasePrimaryActive = isSupabaseCanonicalPrimaryActive(env, canonicalConfig);
  if (!supabasePrimaryActive) {
    assertD1Configured(env, corsOrigin);
  }
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

  const authPayload = await requireSnapshotAuth({ request, corsOrigin, env, verifyIdToken, userId, requestId });
  const authEmail = canonicalizeEmailForMatching(authPayload?.email || '');
  enforcePrivateEndpointRateLimit({ env, userId, corsOrigin, requestId, kind: 'syncWrite' });

  const operations = Array.isArray(body?.operations) ? body.operations : [];
  if (!operations.length) {
    let state = {
      migratedAtMs: null,
      migrationSource: null,
      updatedAtMs: null
    };
    if (supabasePrimaryActive) {
      const stateResult = await readSupabaseSyncState({
        config: canonicalConfig,
        userId,
        requestId
      });
      if (!stateResult.ok) {
        const backupState = await readUserSyncStateFromD1Backup({ env, userId });
        if (!backupState) {
          return errorResponse(503, {
            error: 'storage_unavailable',
            message: 'Supabase canonical storage is unavailable and Cloudflare D1 backup storage is not configured.',
            retryable: true,
            code: 'storage_unavailable',
            requestId
          }, corsOrigin);
        }
        logSupabaseFallback(requestId, 'sector sync state read', stateResult.error || `http_${stateResult.status || 0}`);
        state = backupState;
      } else {
        state = stateResult.state;
      }
    } else {
      state = await readUserSyncState({ db: getD1Database(env), userId });
    }
    const responsePayload = {
      ok: true,
      processed: 0,
      cursorMs: parseSinceMs(body?.cursorMs),
      rejected: [],
      state
    };
    queueSupabaseMirrorWrite({
      executionContext,
      env,
      path: '/sync/sectors/push',
      method: request.method,
      userId,
      requestId,
      requestBody: body,
      responseBody: responsePayload,
      status: 200
    });
    return jsonResponse(200, responsePayload, corsOrigin, { 'x-request-id': requestId });
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

  let cursorMs = parseSinceMs(body?.cursorMs);
  let processed = 0;
  if (supabasePrimaryActive) {
    const rows = [];
    const backupOperations = [];
    const groups = new Set();
    for (let index = 0; index < operations.length; index += 1) {
      const operation = normalizeSectorSyncOperation(operations[index], corsOrigin, index, requestId);
      rows.push(createCanonicalUserDataRow({
        userId,
        scope: 'sector',
        group: operation.sectorKey,
        key: operation.itemKey,
        payload: operation.payload,
        updatedAtMs: operation.updatedAtMs,
        deletedAtMs: operation.deleted ? operation.updatedAtMs : null,
        sourcePath: '/sync/sectors/push',
        requestId,
        opId: operation.opId
      }));
      backupOperations.push(operation);
      groups.add(operation.sectorKey);
      processed += 1;
      if (operation.updatedAtMs > cursorMs) {
        cursorMs = operation.updatedAtMs;
      }
    }
    const supabaseResult = await upsertSupabaseCanonicalOperations({
      config: canonicalConfig,
      userId,
      scope: 'sector',
      sourcePath: '/sync/sectors/push',
      requestId,
      operations: rows,
      groups: [...groups],
      email: isValidEmail(authEmail) ? authEmail : null
    });
    if (!supabaseResult.ok) {
      logSupabaseFallback(requestId, 'sector sync write', supabaseResult.error || `http_${supabaseResult.status || 0}`);
      const backupStored = await tryWriteSectorSyncOperationsToD1Backup({
        env,
        userId,
        deviceId: body?.deviceId,
        operations: backupOperations
      }, requestId);
      if (!backupStored) {
        return errorResponse(503, {
          error: 'storage_unavailable',
          message: 'Supabase canonical storage is unavailable and Cloudflare D1 backup storage is not configured.',
          retryable: true,
          code: 'storage_unavailable',
          requestId
        }, corsOrigin);
      }
    } else {
      await tryWriteSectorSyncOperationsToD1Backup({
        env,
        userId,
        deviceId: body?.deviceId,
        operations: backupOperations
      }, requestId);
    }
  } else {
    const db = getD1Database(env);
    const deviceId = String(body?.deviceId || '').trim() || null;
    const nowIso = new Date().toISOString();
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
  }

  let state = {
    migratedAtMs: null,
    migrationSource: null,
    updatedAtMs: null
  };
  if (supabasePrimaryActive) {
    const stateResult = await readSupabaseSyncState({
      config: canonicalConfig,
      userId,
      requestId
    });
    if (!stateResult.ok) {
      const backupState = await readUserSyncStateFromD1Backup({ env, userId });
      if (!backupState) {
        return errorResponse(503, {
          error: 'storage_unavailable',
          message: 'Supabase canonical storage is unavailable and Cloudflare D1 backup storage is not configured.',
          retryable: true,
          code: 'storage_unavailable',
          requestId
        }, corsOrigin);
      }
      logSupabaseFallback(requestId, 'sector sync state read', stateResult.error || `http_${stateResult.status || 0}`);
      state = backupState;
    } else {
      state = stateResult.state;
    }
  } else {
    const db = getD1Database(env);
    state = await readUserSyncState({ db, userId });
  }
  const responsePayload = {
    ok: true,
    processed,
    cursorMs,
    rejected: [],
    state
  };
  queueSupabaseMirrorWrite({
    executionContext,
    env,
    path: '/sync/sectors/push',
    method: request.method,
    userId,
    requestId,
    requestBody: body,
    responseBody: responsePayload,
    status: 200
  });
  return jsonResponse(200, responsePayload, corsOrigin, { 'x-request-id': requestId });
}

async function handleSectorSyncPull({ request, env, corsOrigin, verifyIdToken, requestId }) {
  const canonicalConfig = resolveSupabaseCanonicalConfig(env);
  const supabasePrimaryActive = isSupabaseCanonicalPrimaryActive(env, canonicalConfig);
  if (!supabasePrimaryActive) {
    assertD1Configured(env, corsOrigin);
  }
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
  enforcePrivateEndpointRateLimit({ env, userId, corsOrigin, requestId, kind: 'syncRead' });

  const sinceMs = parseSinceMs(url.searchParams.get('since'));
  const limit = parsePullLimit(url.searchParams.get('limit'));
  const cursor = normalizeSharedFeedCursor({
    updatedAtMs: url.searchParams.get('cursorUpdatedAtMs'),
    opId: url.searchParams.get('cursorOpId'),
    sectorKey: url.searchParams.get('cursorSectorKey'),
    itemKey: url.searchParams.get('cursorItemKey')
  });
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

  let rows = [];
  if (supabasePrimaryActive) {
    const cooldownState = getSupabaseCanonicalReadCooldownState(userId);
    let supabaseQuery = null;
    if (!cooldownState.blocked) {
      const searchParams = {
        user_id: `eq.${userId}`,
        data_scope: 'eq.sector'
      };
      const cursorFilter = buildSupabaseSyncCursorFilter(cursor);
      if (cursorFilter) {
        searchParams.or = `(${cursorFilter})`;
      } else {
        searchParams.updated_at_ms = `gt.${sinceMs}`;
      }
      const sectorsFilter = buildSupabaseInFilter(requestedSectors);
      if (sectorsFilter) {
        searchParams.data_group = `in.${sectorsFilter}`;
      }
      supabaseQuery = await selectSupabaseCanonicalRows({
        config: canonicalConfig,
        table: canonicalConfig.userDataTable,
        select: 'data_group,data_key,payload_json,updated_at_ms,deleted_at_ms,op_id',
        searchParams,
        order: 'updated_at_ms.asc,op_id.asc.nullsfirst,data_group.asc,data_key.asc',
        limit,
        requestId
      });
    }
    if (supabaseQuery?.ok) {
      clearSupabaseCanonicalReadCooldown(userId);
      rows = supabaseQuery.rows;
    } else {
      const retryAfterSeconds = supabaseQuery
        ? recordSupabaseCanonicalReadCooldown({ env, userId, status: supabaseQuery.status })
        : cooldownState.retryAfterSeconds;
      const backupRows = await readSectorSyncRowsFromD1Backup({
        env,
        userId,
        sinceMs,
        limit,
        sectors: requestedSectors,
        cursor
      });
      if (backupRows) {
        logSupabaseFallback(
          requestId,
          'sector sync read',
          supabaseQuery ? (supabaseQuery.error || `http_${supabaseQuery.status || 0}`) : 'read_cooldown'
        );
        rows = backupRows;
      } else {
        enforceSupabaseCanonicalReadCooldown({ env, userId, corsOrigin, requestId });
        const retryHeaders = retryAfterSeconds > 0 ? { 'retry-after': String(retryAfterSeconds) } : undefined;
        return errorResponse(503, {
          error: 'storage_unavailable',
          message: 'Supabase canonical storage is unavailable and Cloudflare D1 backup storage is not configured.',
          retryable: true,
          code: 'storage_unavailable',
          requestId
        }, corsOrigin, retryHeaders);
      }
    }
  } else {
    rows = await readSectorSyncRowsFromD1Backup({
      env,
      userId,
      sinceMs,
      limit,
      sectors: requestedSectors,
      cursor
    }) || [];
  }

  let cursorTuple = cursor || normalizeSharedFeedCursor({ updatedAtMs: sinceMs });
  const operations = [];

  rows.forEach((row) => {
    const updatedAtMs = parseSinceMs(row?.updated_at_ms);
    cursorTuple = chooseLaterSyncCursor(cursorTuple, buildSectorPullCursorFromRow(row));
    const sectorKey = normalizeSectorKey(row?.sector_key ?? row?.data_group);
    const itemKey = normalizeItemKey(row?.item_key ?? row?.data_key);
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

    const payload = parseCanonicalPayloadObject(row?.item_json ?? row?.payload_json);
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

  let state = {
    migratedAtMs: null,
    migrationSource: null,
    updatedAtMs: null
  };
  if (supabasePrimaryActive) {
    const stateResult = await readSupabaseSyncState({
      config: canonicalConfig,
      userId,
      requestId
    });
    if (!stateResult.ok) {
      const backupState = await readUserSyncStateFromD1Backup({ env, userId });
      if (!backupState) {
        return errorResponse(503, {
          error: 'storage_unavailable',
          message: 'Supabase canonical storage is unavailable and Cloudflare D1 backup storage is not configured.',
          retryable: true,
          code: 'storage_unavailable',
          requestId
        }, corsOrigin);
      }
      logSupabaseFallback(requestId, 'sector sync state read', stateResult.error || `http_${stateResult.status || 0}`);
      state = backupState;
    } else {
      state = stateResult.state;
    }
  } else {
    const db = getD1Database(env);
    state = await readUserSyncState({ db, userId });
  }
  return jsonResponse(200, {
    ok: true,
    sinceMs,
    cursorMs: parseSinceMs(cursorTuple?.updatedAtMs || sinceMs),
    cursorUpdatedAtMs: parseSinceMs(cursorTuple?.updatedAtMs || sinceMs),
    cursorOpId: normalizeOperationId(cursorTuple?.opId),
    cursorSectorKey: normalizeSectorKey(cursorTuple?.sectorKey),
    cursorItemKey: normalizeItemKey(cursorTuple?.itemKey),
    operations,
    state
  }, corsOrigin, { 'x-request-id': requestId });
}

async function handleSectorSyncBootstrap({ request, env, corsOrigin, verifyIdToken, requestId, executionContext = null }) {
  const canonicalConfig = resolveSupabaseCanonicalConfig(env);
  const supabasePrimaryActive = isSupabaseCanonicalPrimaryActive(env, canonicalConfig);
  if (!supabasePrimaryActive) {
    assertD1Configured(env, corsOrigin);
  }
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

  const authPayload = await requireSnapshotAuth({ request, corsOrigin, env, verifyIdToken, userId, requestId });
  const authEmail = canonicalizeEmailForMatching(authPayload?.email || '');
  enforcePrivateEndpointRateLimit({ env, userId, corsOrigin, requestId, kind: 'syncWrite' });

  let currentState = {
    migratedAtMs: null,
    migrationSource: null,
    updatedAtMs: null
  };
  if (supabasePrimaryActive) {
    const stateResult = await readSupabaseSyncState({
      config: canonicalConfig,
      userId,
      requestId
    });
    if (!stateResult.ok) {
      const backupState = await readUserSyncStateFromD1Backup({ env, userId });
      if (!backupState) {
        return errorResponse(503, {
          error: 'storage_unavailable',
          message: 'Supabase canonical storage is unavailable and Cloudflare D1 backup storage is not configured.',
          retryable: true,
          code: 'storage_unavailable',
          requestId
        }, corsOrigin);
      }
      logSupabaseFallback(requestId, 'sector bootstrap state read', stateResult.error || `http_${stateResult.status || 0}`);
      currentState = backupState;
    } else {
      currentState = stateResult.state;
    }
  } else {
    const db = getD1Database(env);
    currentState = await readUserSyncState({ db, userId });
  }
  if (currentState.migratedAtMs) {
    const responsePayload = {
      ok: true,
      skipped: true,
      processed: 0,
      cursorMs: currentState.migratedAtMs,
      state: currentState
    };
    queueSupabaseMirrorWrite({
      executionContext,
      env,
      path: '/sync/sectors/bootstrap',
      method: request.method,
      userId,
      requestId,
      requestBody: body,
      responseBody: responsePayload,
      status: 200
    });
    return jsonResponse(200, responsePayload, corsOrigin, { 'x-request-id': requestId });
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

  const migratedAtMs = Date.now();
  const migrationSource = String(body?.migrationSource || '').trim() || 'unknown';
  let cursorMs = parseSinceMs(body?.cursorMs);
  let processed = 0;
  if (supabasePrimaryActive) {
    const rows = [];
    const backupOperations = [];
    const groups = new Set();
    for (let index = 0; index < operations.length; index += 1) {
      const operation = normalizeSectorSyncOperation(operations[index], corsOrigin, index, requestId);
      rows.push(createCanonicalUserDataRow({
        userId,
        scope: 'sector',
        group: operation.sectorKey,
        key: operation.itemKey,
        payload: operation.payload,
        updatedAtMs: operation.updatedAtMs,
        deletedAtMs: operation.deleted ? operation.updatedAtMs : null,
        sourcePath: '/sync/sectors/bootstrap',
        requestId,
        opId: operation.opId
      }));
      backupOperations.push(operation);
      groups.add(operation.sectorKey);
      processed += 1;
      if (operation.updatedAtMs > cursorMs) {
        cursorMs = operation.updatedAtMs;
      }
    }
    const writeResult = await upsertSupabaseCanonicalOperations({
      config: canonicalConfig,
      userId,
      scope: 'sector',
      sourcePath: '/sync/sectors/bootstrap',
      requestId,
      operations: rows,
      groups: [...groups],
      email: isValidEmail(authEmail) ? authEmail : null
    });
    if (!writeResult.ok) {
      logSupabaseFallback(requestId, 'sector bootstrap write', writeResult.error || `http_${writeResult.status || 0}`);
      const backupStored = await tryWriteSectorSyncOperationsToD1Backup({
        env,
        userId,
        deviceId: body?.deviceId,
        operations: backupOperations
      }, requestId);
      const backupDb = getD1Database(env);
      if (backupStored && backupDb) {
        try {
          await persistUserSyncState({
            db: backupDb,
            userId,
            migratedAtMs,
            migrationSource,
            updatedAtMs: migratedAtMs
          });
        } catch (error) {
          console.warn(`[api][${requestId || 'no-request-id'}] cloudflare d1 sector bootstrap state backup write failed: ${String(error?.message || error || 'unknown')}`);
        }
      }
      if (!backupStored) {
        return errorResponse(503, {
          error: 'storage_unavailable',
          message: 'Supabase canonical storage is unavailable and Cloudflare D1 backup storage is not configured.',
          retryable: true,
          code: 'storage_unavailable',
          requestId
        }, corsOrigin);
      }
    } else {
      const stateWriteResult = await persistSupabaseSyncState({
        config: canonicalConfig,
        userId,
        state: {
          migratedAtMs,
          migrationSource,
          updatedAtMs: migratedAtMs
        },
        requestId,
        sourcePath: '/sync/sectors/bootstrap'
      });
      if (!stateWriteResult.ok) {
        logSupabaseFallback(requestId, 'sector bootstrap state write', stateWriteResult.error || `http_${stateWriteResult.status || 0}`);
      }
      await tryWriteSectorSyncOperationsToD1Backup({
        env,
        userId,
        deviceId: body?.deviceId,
        operations: backupOperations
      }, requestId);
      const backupDb = getD1Database(env);
      if (backupDb) {
        try {
          await persistUserSyncState({
            db: backupDb,
            userId,
            migratedAtMs,
            migrationSource,
            updatedAtMs: migratedAtMs
          });
        } catch (error) {
          console.warn(`[api][${requestId || 'no-request-id'}] cloudflare d1 sector bootstrap state backup write failed: ${String(error?.message || error || 'unknown')}`);
        }
      }
    }
  } else {
    const db = getD1Database(env);
    const deviceId = String(body?.deviceId || '').trim() || null;
    const nowIso = new Date().toISOString();
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
  }

  let state = {
    migratedAtMs,
    migrationSource,
    updatedAtMs: migratedAtMs
  };
  if (supabasePrimaryActive) {
    const stateResult = await readSupabaseSyncState({
      config: canonicalConfig,
      userId,
      requestId
    });
    if (stateResult.ok) {
      state = stateResult.state;
    }
  } else {
    const db = getD1Database(env);
    state = await readUserSyncState({ db, userId });
  }
  const responsePayload = {
    ok: true,
    skipped: false,
    processed,
    cursorMs: Math.max(cursorMs, migratedAtMs),
    state
  };
  queueSupabaseMirrorWrite({
    executionContext,
    env,
    path: '/sync/sectors/bootstrap',
    method: request.method,
    userId,
    requestId,
    requestBody: body,
    responseBody: responsePayload,
    status: 200
  });
  return jsonResponse(200, responsePayload, corsOrigin, { 'x-request-id': requestId });
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
      writes.push(persistSnapshot({
        env,
        userId,
        snapshot: docData || {},
        corsOrigin,
        requestId: 'import'
      }));
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
    writes.push(persistSnapshot({
      env,
      userId,
      snapshot: docData || {},
      corsOrigin,
      requestId: 'bulk-import'
    }));
    count += 1;
    if (writes.length >= 25) {
      await Promise.all(writes);
      writes.length = 0;
    }
  }

  if (writes.length) await Promise.all(writes);
  return jsonResponse(200, { ok: true, imported: count }, corsOrigin);
}

async function handleGetSnapshot({ request, env, corsOrigin, verifyIdToken, requestId }) {
  assertStorageConfigured(env, corsOrigin);
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
  enforcePrivateEndpointRateLimit({ env, userId, corsOrigin, requestId, kind: 'snapshotRead' });

  const wantsMeta = url.searchParams.get('meta') === 'true';

  if (wantsMeta) {
    return jsonResponse(200, await readSnapshotMeta({ env, userId, requestId }), corsOrigin, { 'x-request-id': requestId });
  }

  const value = await readSnapshotValue({ env, userId, requestId });
  if (value === null) {
    return errorResponse(404, {
      error: 'not_found',
      message: 'No cloud backup found for this account yet. Open Bilm Settings > Account > Data Transfer and use Cloud Export first.',
      retryable: false,
      code: 'snapshot_not_found',
      requestId
    }, corsOrigin);
  }

  return textResponse(200, value, corsOrigin, { 'x-request-id': requestId });
}

async function handleSaveSnapshot({ request, env, corsOrigin, verifyIdToken, requestId, executionContext = null }) {
  assertStorageConfigured(env, corsOrigin);
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

  const authPayload = await requireSnapshotAuth({ request, corsOrigin, env, verifyIdToken, userId, requestId });
  const authEmail = canonicalizeEmailForMatching(authPayload?.email || '');
  enforcePrivateEndpointRateLimit({ env, userId, corsOrigin, requestId, kind: 'snapshotWrite' });

  const payload = extractSnapshotFromSaveBody(body);
  if (!payload) {
    return errorResponse(400, {
      error: 'missing_data',
      message: 'Backup data is missing. Use Cloud Export in Bilm Settings, or send a bilm-backup-v1 JSON object as data, snapshot, value, backup, export, or the request body.',
      retryable: false,
      code: 'missing_snapshot_data',
      requestId
    }, corsOrigin);
  }

  const result = await persistSnapshot({
    env,
    userId,
    snapshot: payload,
    corsOrigin,
    requestId,
    email: isValidEmail(authEmail) ? authEmail : null
  });

  const responsePayload = {
    ok: true,
    saved: true,
    bytes: result?.bytes || 0
  };
  queueSupabaseMirrorWrite({
    executionContext,
    env,
    path: '/',
    method: request.method,
    userId,
    requestId,
    requestBody: body,
    responseBody: responsePayload,
    status: 200
  });
  return jsonResponse(200, responsePayload, corsOrigin, { 'x-request-id': requestId });
}

function buildHealthPayload(env) {
  const hasD1 = Boolean(getD1Database(env));
  const hasKv = Boolean(getKvNamespace(env));
  const hasR2 = Boolean(getR2Bucket(env));
  const supabaseMirror = resolveSupabaseMirrorConfig(env);
  const supabaseCanonical = resolveSupabaseCanonicalConfig(env);
  const supabaseCanonicalPrimaryActive = isSupabaseCanonicalPrimaryActive(env, supabaseCanonical);
  return {
    ok: true,
    service: 'data-api',
    checkedAtMs: Date.now(),
    storage: {
      d1: hasD1,
      kv: hasKv,
      r2: hasR2,
      snapshotStorageReady: supabaseCanonicalPrimaryActive || hasD1 || hasKv,
      syncStorageReady: supabaseCanonicalPrimaryActive || hasD1
    },
    mirrors: {
      supabase: {
        enabled: supabaseMirror.enabled === true,
        active: supabaseMirror.active === true,
        projectConfigured: Boolean(supabaseMirror.projectUrl),
        serviceRoleConfigured: Boolean(supabaseMirror.serviceRoleKey),
        table: supabaseMirror.table,
        timeoutMs: supabaseMirror.timeoutMs,
        writesAttempted: Number(SUPABASE_MIRROR_RUNTIME.attempted || 0) || 0,
        writesSucceeded: Number(SUPABASE_MIRROR_RUNTIME.succeeded || 0) || 0,
        writesFailed: Number(SUPABASE_MIRROR_RUNTIME.failed || 0) || 0,
        lastAttemptAtMs: Number(SUPABASE_MIRROR_RUNTIME.lastAttemptAtMs || 0) || 0,
        lastSuccessAtMs: Number(SUPABASE_MIRROR_RUNTIME.lastSuccessAtMs || 0) || 0,
        lastFailureAtMs: Number(SUPABASE_MIRROR_RUNTIME.lastFailureAtMs || 0) || 0,
        lastFailureStatus: Number(SUPABASE_MIRROR_RUNTIME.lastFailureStatus || 0) || 0,
        lastError: String(SUPABASE_MIRROR_RUNTIME.lastError || ''),
        lastProbeAtMs: Number(SUPABASE_MIRROR_RUNTIME.lastProbeAtMs || 0) || 0,
        lastProbeStatus: Number(SUPABASE_MIRROR_RUNTIME.lastProbeStatus || 0) || 0,
        lastProbeOk: SUPABASE_MIRROR_RUNTIME.lastProbeOk === true,
        lastProbeError: String(SUPABASE_MIRROR_RUNTIME.lastProbeError || ''),
        canonical: {
          enabled: supabaseCanonical.enabled === true,
          active: supabaseCanonical.active === true,
          primaryMode: supabaseCanonicalPrimaryActive === true,
          profileTable: supabaseCanonical.profileTable,
          userDataTable: supabaseCanonical.userDataTable,
          timeoutMs: supabaseCanonical.timeoutMs,
          batchSize: supabaseCanonical.batchSize,
          deletedRetentionDays: supabaseCanonical.deletedRetentionDays,
          writesAttempted: Number(SUPABASE_CANONICAL_RUNTIME.attempted || 0) || 0,
          writesSucceeded: Number(SUPABASE_CANONICAL_RUNTIME.succeeded || 0) || 0,
          writesFailed: Number(SUPABASE_CANONICAL_RUNTIME.failed || 0) || 0,
          lastAttemptAtMs: Number(SUPABASE_CANONICAL_RUNTIME.lastAttemptAtMs || 0) || 0,
          lastSuccessAtMs: Number(SUPABASE_CANONICAL_RUNTIME.lastSuccessAtMs || 0) || 0,
          lastFailureAtMs: Number(SUPABASE_CANONICAL_RUNTIME.lastFailureAtMs || 0) || 0,
          lastFailureStatus: Number(SUPABASE_CANONICAL_RUNTIME.lastFailureStatus || 0) || 0,
          lastError: String(SUPABASE_CANONICAL_RUNTIME.lastError || ''),
          purgeAttempted: Number(SUPABASE_CANONICAL_RUNTIME.purgeAttempted || 0) || 0,
          purgeSucceeded: Number(SUPABASE_CANONICAL_RUNTIME.purgeSucceeded || 0) || 0,
          purgeFailed: Number(SUPABASE_CANONICAL_RUNTIME.purgeFailed || 0) || 0,
          lastPurgeAtMs: Number(SUPABASE_CANONICAL_RUNTIME.lastPurgeAtMs || 0) || 0,
          lastPurgeCutoffMs: Number(SUPABASE_CANONICAL_RUNTIME.lastPurgeCutoffMs || 0) || 0,
          lastPurgeStatus: Number(SUPABASE_CANONICAL_RUNTIME.lastPurgeStatus || 0) || 0,
          lastPurgeError: String(SUPABASE_CANONICAL_RUNTIME.lastPurgeError || '')
        }
      }
    },
    endpoints: [
      { id: 'login_gate', method: 'GET', path: '/?userId=<uid>', expectedStatuses: [200, 401, 404] },
      { id: 'cloud_export_save', method: 'POST', path: '/', expectedStatuses: [200, 401] },
      { id: 'cloud_import_read', method: 'GET', path: '/?userId=<uid>', expectedStatuses: [200, 401, 404] },
      { id: 'sync_pull', method: 'GET', path: '/sync/sectors/pull?userId=<uid>&since=0', expectedStatuses: [200, 401] },
      { id: 'sync_push', method: 'POST', path: '/sync/sectors/push', expectedStatuses: [200, 401] },
      { id: 'account_links_list', method: 'GET', path: '/links?userId=<uid>', expectedStatuses: [200, 401] },
      { id: 'account_links_request', method: 'POST', path: '/links/request', expectedStatuses: [200, 400, 401, 409] },
      { id: 'account_links_shared_feed', method: 'GET', path: '/links/shared-feed?userId=<uid>&since=0', expectedStatuses: [200, 401] },
      { id: 'account_reset', method: 'POST', path: '/account/reset', expectedStatuses: [200, 400, 401, 403] },
      { id: 'import_admin_guard', method: 'POST', path: '/?import=true', expectedStatuses: [200, 401, 403] }
    ]
  };
}

async function handleHealthCheck({ request, env, corsOrigin }) {
  const url = new URL(request.url);
  const shouldProbe = (
    String(url.searchParams.get('probe') || '').trim() === '1'
    || String(url.searchParams.get('probe') || '').trim().toLowerCase() === 'true'
  );
  const health = buildHealthPayload(env);
  if (!shouldProbe) {
    return jsonResponse(200, health, corsOrigin);
  }
  const probe = await probeSupabaseMirrorConnection(env);
  return jsonResponse(200, {
    ...health,
    mirrors: {
      ...(health?.mirrors || {}),
      supabase: {
        ...(health?.mirrors?.supabase || {}),
        probe
      }
    }
  }, corsOrigin);
}

export function createWorker({ verifyIdToken = verifyFirebaseIdToken, allowedOrigins = DEFAULT_ALLOWED_ORIGINS } = {}) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const origin = request.headers.get('origin');
      const corsOrigin = origin && allowedOrigins.has(origin) ? origin : '';
      const requestId = createRequestId();

      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            ...API_SECURITY_HEADERS,
            ...createCorsHeaders(corsOrigin),
            allow: 'GET, POST, OPTIONS',
            'x-request-id': requestId
          }
        });
      }

      try {
        if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
          return await handleHealthCheck({ request, env, corsOrigin });
        }

        if (url.pathname.startsWith('/media/')) {
          return errorResponse(404, {
            error: 'route_not_found',
            message: 'Media routes are not available on data-api.',
            retryable: false,
            code: 'route_not_found',
            requestId
          }, corsOrigin);
        }

        if (request.method === 'GET' && url.pathname === '/links') {
          return await handleListAccountLinks({ request, env, corsOrigin, verifyIdToken, requestId });
        }

        if (request.method === 'GET' && url.pathname === '/links/target-capabilities') {
          return await handleGetAccountLinkTargetCapabilities({ request, env, corsOrigin, verifyIdToken, requestId });
        }

        if (request.method === 'GET' && url.pathname === '/links/shared-feed') {
          return await handlePullLinkedSharedFeed({ request, env, corsOrigin, verifyIdToken, requestId });
        }

        if (request.method === 'POST' && url.pathname === '/links/request') {
          return await handleCreateAccountLinkRequest({
            request,
            env,
            corsOrigin,
            verifyIdToken,
            requestId,
            executionContext: ctx
          });
        }

        if (request.method === 'POST' && url.pathname === '/links/respond') {
          return await handleRespondToAccountLinkRequest({
            request,
            env,
            corsOrigin,
            verifyIdToken,
            requestId,
            executionContext: ctx
          });
        }

        if (request.method === 'POST' && url.pathname === '/links/scopes') {
          return await handleUpdateAccountLinkScopes({
            request,
            env,
            corsOrigin,
            verifyIdToken,
            requestId,
            executionContext: ctx
          });
        }

        if (request.method === 'POST' && url.pathname === '/links/unlink') {
          return await handleUnlinkAccountLink({
            request,
            env,
            corsOrigin,
            verifyIdToken,
            requestId,
            executionContext: ctx
          });
        }

        if (request.method === 'POST' && url.pathname === '/links/chat-ready') {
          return await handleMarkAccountChatReady({
            request,
            env,
            corsOrigin,
            verifyIdToken,
            requestId,
            executionContext: ctx
          });
        }

        if (request.method === 'POST' && url.pathname === '/account/reset') {
          return await handleResetAccountData({
            request,
            env,
            corsOrigin,
            verifyIdToken,
            requestId,
            executionContext: ctx
          });
        }

        if (request.method === 'POST' && url.pathname === '/sync/sectors/push') {
          return await handleSectorSyncPush({
            request,
            env,
            corsOrigin,
            verifyIdToken,
            requestId,
            executionContext: ctx
          });
        }

        if (request.method === 'GET' && url.pathname === '/sync/sectors/pull') {
          return await handleSectorSyncPull({ request, env, corsOrigin, verifyIdToken, requestId });
        }

        if (request.method === 'POST' && url.pathname === '/sync/sectors/bootstrap') {
          return await handleSectorSyncBootstrap({
            request,
            env,
            corsOrigin,
            verifyIdToken,
            requestId,
            executionContext: ctx
          });
        }

        if (request.method === 'POST' && url.pathname === '/sync/lists/push') {
          return await handleListSyncPush({
            request,
            env,
            corsOrigin,
            verifyIdToken,
            requestId,
            executionContext: ctx
          });
        }

        if (request.method === 'GET' && url.pathname === '/sync/lists/pull') {
          return await handleListSyncPull({ request, env, corsOrigin, verifyIdToken, requestId });
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
          return await handleGetSnapshot({ request, env, corsOrigin, verifyIdToken, requestId });
        }

        if (request.method === 'POST') {
          return await handleSaveSnapshot({
            request,
            env,
            corsOrigin,
            verifyIdToken,
            requestId,
            executionContext: ctx
          });
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
        const errorMessage = String(error?.message || error || 'unknown_error');
        const errorStack = String(error?.stack || '');
        console.error('data-api request failed', {
          requestId,
          method: request.method,
          pathname: url.pathname,
          searchParamKeys: [...new Set(url.searchParams.keys())].slice(0, 20),
          message: errorMessage,
          stack: errorStack ? errorStack.slice(0, 2000) : ''
        });

        if (/no such table|no such column|sqlite|d1/i.test(`${errorMessage}\n${errorStack}`)) {
          return errorResponse(503, {
            error: 'storage_unavailable',
            message: 'Storage is initializing. Please retry shortly.',
            retryable: true,
            code: 'storage_unavailable',
            requestId
          }, corsOrigin);
        }
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
      try {
        await purgeExpiredSupabaseCanonicalRows({ env });
      } catch (error) {
        console.error('scheduled supabase canonical purge failed:', error);
      }
    }
  };
}

export default createWorker();

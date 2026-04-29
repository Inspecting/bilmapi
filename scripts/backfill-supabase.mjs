#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const D1_DB_NAME = process.env.BACKFILL_D1_DB_NAME || 'bilm-data';
const SUPABASE_URL = String(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const PROFILE_TABLE = String(process.env.SUPABASE_CANONICAL_PROFILE_TABLE || 'bilm_profiles').trim();
const USER_DATA_TABLE = String(process.env.SUPABASE_CANONICAL_USER_DATA_TABLE || 'bilm_user_data').trim();
const PAGE_SIZE = clampInt(process.env.BACKFILL_PAGE_SIZE, 200, 25, 1000);
const POST_BATCH_SIZE = clampInt(process.env.BACKFILL_POST_BATCH_SIZE, 100, 1, 500);
const MAX_ROWS_PER_TABLE = clampInt(process.env.BACKFILL_MAX_ROWS_PER_TABLE, 0, 0, 5_000_000);
const DRY_RUN = String(process.env.BACKFILL_DRY_RUN || '').trim() === '1';
const WRANGLER_BIN = resolveWranglerBin();
const BACKFILLED_AT_MS = Date.now();
const BACKFILLED_AT_ISO = new Date(BACKFILLED_AT_MS).toISOString();

if (!SUPABASE_URL) {
  throw new Error('Missing SUPABASE_URL (or SUPABASE_PROJECT_URL).');
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY.');
}

const profileRowsByUserId = new Map();
const userDataRowsByKey = new Map();

const tableSpecs = [
  {
    table: 'user_snapshots',
    orderBy: 'user_id',
    select: [
      'user_id',
      'snapshot_json',
      'updated_at_ms',
      'device_id',
      'schema',
      'saved_at'
    ],
    handleRow: (row) => {
      const userId = normalizeUserId(row.user_id);
      if (!userId) return;
      const payload = normalizePayloadObject(safeJsonParse(row.snapshot_json, null), {
        fallbackText: row.snapshot_json
      });
      const updatedAtMs = normalizeMs(row.updated_at_ms) || Date.now();
      const occurredAtIso = normalizeIso(row.saved_at) || isoFromMs(updatedAtMs);
      upsertProfileRow(userId, {
        lastPath: '/',
        lastSeenAtIso: occurredAtIso,
        sourceTable: 'user_snapshots',
        metadataPatch: {
          snapshotSchema: String(row.schema || '').trim() || null,
          snapshotDeviceId: String(row.device_id || '').trim() || null
        }
      });
      upsertCanonicalUserDataRow(createCanonicalUserDataRow({
        stableKey: `snapshot:${userId}`,
        userId,
        scope: 'snapshot',
        group: 'snapshot',
        key: 'snapshot',
        payload,
        updatedAtMs,
        deletedAtMs: null,
        sourcePath: '/',
        requestId: `backfill-snapshot-${userId}`,
        occurredAtIso
      }));
    }
  },
  {
    table: 'sync_items',
    orderBy: 'user_id, sector_key, item_key',
    select: [
      'user_id',
      'sector_key',
      'item_key',
      'item_json',
      'updated_at_ms',
      'deleted_at_ms',
      'device_id',
      'op_id',
      'saved_at'
    ],
    handleRow: (row) => {
      const userId = normalizeUserId(row.user_id);
      const sectorKey = String(row.sector_key || '').trim();
      const itemKey = String(row.item_key || '').trim();
      if (!userId || !sectorKey || !itemKey) return;
      const updatedAtMs = normalizeMs(row.updated_at_ms) || Date.now();
      const deletedAtMs = normalizeMs(row.deleted_at_ms);
      const occurredAtIso = normalizeIso(row.saved_at) || isoFromMs(updatedAtMs, deletedAtMs);
      upsertProfileRow(userId, {
        lastPath: '/sync/sectors/push',
        lastSeenAtIso: occurredAtIso,
        sourceTable: 'sync_items',
        metadataPatch: {
          lastSectorDeviceId: String(row.device_id || '').trim() || null
        }
      });
      upsertCanonicalUserDataRow(createCanonicalUserDataRow({
        stableKey: `sector:${userId}:${sectorKey}:${itemKey}`,
        userId,
        scope: 'sector',
        group: sectorKey,
        key: itemKey,
        payload: deletedAtMs ? null : normalizePayloadObject(safeJsonParse(row.item_json, null), {
          fallbackText: row.item_json
        }),
        updatedAtMs,
        deletedAtMs,
        sourcePath: '/sync/sectors/push',
        requestId: `backfill-sector-${userId}`,
        occurredAtIso,
        opId: String(row.op_id || '').trim() || null
      }));
    }
  },
  {
    table: 'list_sync_items',
    orderBy: 'user_id, list_key, item_key',
    select: [
      'user_id',
      'list_key',
      'item_key',
      'item_json',
      'updated_at_ms',
      'deleted_at_ms',
      'device_id',
      'saved_at'
    ],
    handleRow: (row) => {
      const userId = normalizeUserId(row.user_id);
      const listKey = String(row.list_key || '').trim();
      const itemKey = String(row.item_key || '').trim();
      if (!userId || !listKey || !itemKey) return;
      const updatedAtMs = normalizeMs(row.updated_at_ms) || Date.now();
      const deletedAtMs = normalizeMs(row.deleted_at_ms);
      const occurredAtIso = normalizeIso(row.saved_at) || isoFromMs(updatedAtMs, deletedAtMs);
      upsertProfileRow(userId, {
        lastPath: '/sync/lists/push',
        lastSeenAtIso: occurredAtIso,
        sourceTable: 'list_sync_items',
        metadataPatch: {
          lastListDeviceId: String(row.device_id || '').trim() || null
        }
      });
      upsertCanonicalUserDataRow(createCanonicalUserDataRow({
        stableKey: `list:${userId}:${listKey}:${itemKey}`,
        userId,
        scope: 'list',
        group: listKey,
        key: itemKey,
        payload: deletedAtMs ? null : normalizePayloadObject(safeJsonParse(row.item_json, null), {
          fallbackText: row.item_json
        }),
        updatedAtMs,
        deletedAtMs,
        sourcePath: '/sync/lists/push',
        requestId: `backfill-list-${userId}`,
        occurredAtIso
      }));
    }
  },
  {
    table: 'user_sync_state',
    orderBy: 'user_id',
    select: [
      'user_id',
      'migrated_at_ms',
      'migration_source',
      'updated_at_ms',
      'saved_at'
    ],
    handleRow: (row) => {
      const userId = normalizeUserId(row.user_id);
      if (!userId) return;
      const migratedAtMs = normalizeMs(row.migrated_at_ms);
      const updatedAtMs = normalizeMs(row.updated_at_ms) || migratedAtMs || Date.now();
      const occurredAtIso = normalizeIso(row.saved_at) || isoFromMs(updatedAtMs, migratedAtMs);
      upsertProfileRow(userId, {
        lastPath: '/sync/sectors/push',
        lastSeenAtIso: occurredAtIso,
        sourceTable: 'user_sync_state'
      });
      upsertCanonicalUserDataRow(createCanonicalUserDataRow({
        stableKey: `sync-state:${userId}`,
        userId,
        scope: 'sync_state',
        group: 'sync',
        key: 'state',
        payload: {
          migratedAtMs,
          migrationSource: String(row.migration_source || '').trim() || null,
          updatedAtMs,
          savedAt: normalizeIso(row.saved_at)
        },
        updatedAtMs,
        deletedAtMs: null,
        sourcePath: '/sync/sectors/push',
        requestId: `backfill-sync-state-${userId}`,
        occurredAtIso
      }));
    }
  }
];

for (const spec of tableSpecs) {
  const rows = fetchAllRows(spec);
  rows.forEach(spec.handleRow);
  console.log(`BACKFILL_TABLE ${spec.table} rows=${rows.length}`);
}

const profileRows = [...profileRowsByUserId.values()];
const userDataRows = [...userDataRowsByKey.values()];

console.log(`BACKFILL_PROFILE_ROWS=${profileRows.length}`);
console.log(`BACKFILL_USER_DATA_ROWS=${userDataRows.length}`);
console.log('BACKFILL_SKIPPED_TABLES=account_links,account_user_capabilities');

if (DRY_RUN) {
  console.log('BACKFILL_DRY_RUN=1 (no writes sent)');
  process.exit(0);
}

await postRows({
  table: PROFILE_TABLE,
  rows: profileRows,
  onConflict: 'user_id'
});
await postRows({
  table: USER_DATA_TABLE,
  rows: userDataRows,
  onConflict: 'user_id,data_scope,data_group,data_key'
});

console.log('BACKFILL_DONE');

function fetchAllRows(spec) {
  const rows = [];
  let offset = 0;
  while (true) {
    if (MAX_ROWS_PER_TABLE > 0 && rows.length >= MAX_ROWS_PER_TABLE) break;
    const remaining = MAX_ROWS_PER_TABLE > 0 ? Math.max(0, MAX_ROWS_PER_TABLE - rows.length) : PAGE_SIZE;
    const pageLimit = MAX_ROWS_PER_TABLE > 0 ? Math.min(PAGE_SIZE, remaining) : PAGE_SIZE;
    if (pageLimit <= 0) break;
    const sql = `SELECT ${spec.select.join(', ')} FROM ${spec.table} ORDER BY ${spec.orderBy} LIMIT ${pageLimit} OFFSET ${offset};`;
    const page = runWranglerD1Query(sql);
    if (!page.length) break;
    rows.push(...page);
    offset += page.length;
    if (page.length < pageLimit) break;
  }
  return rows;
}

function upsertProfileRow(userId, {
  lastPath = '/backfill',
  lastSeenAtIso = BACKFILLED_AT_ISO,
  sourceTable = '',
  metadataPatch = {},
  email = ''
} = {}) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return;
  const normalizedSeenAtIso = normalizeIso(lastSeenAtIso) || BACKFILLED_AT_ISO;
  const existing = profileRowsByUserId.get(normalizedUserId);
  const existingSeenAtMs = existing ? Date.parse(String(existing.last_seen_at || '')) || 0 : 0;
  const nextSeenAtMs = Date.parse(normalizedSeenAtIso) || BACKFILLED_AT_MS;
  const sourceTables = new Set(Array.isArray(existing?.metadata_json?.sourceTables) ? existing.metadata_json.sourceTables : []);
  if (sourceTable) sourceTables.add(sourceTable);
  const mergedMetadata = {
    ...(existing?.metadata_json || {}),
    ...(metadataPatch && typeof metadataPatch === 'object' ? metadataPatch : {}),
    sourceTables: [...sourceTables].sort(),
    backfilledAtMs: BACKFILLED_AT_MS
  };

  const nextRow = {
    user_id: normalizedUserId,
    source: 'data-api-backfill',
    last_path: nextSeenAtMs >= existingSeenAtMs
      ? (String(lastPath || '').trim() || '/backfill')
      : (String(existing?.last_path || '').trim() || '/backfill'),
    last_seen_at: nextSeenAtMs >= existingSeenAtMs
      ? normalizedSeenAtIso
      : (existing?.last_seen_at || normalizedSeenAtIso),
    updated_at: BACKFILLED_AT_ISO,
    metadata_json: mergedMetadata
  };
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (normalizedEmail) {
    nextRow.email = normalizedEmail;
  } else if (existing?.email) {
    nextRow.email = existing.email;
  }
  profileRowsByUserId.set(normalizedUserId, nextRow);
}

function upsertCanonicalUserDataRow(row) {
  if (!row || typeof row !== 'object') return;
  const compositeKey = [
    String(row.user_id || '').trim(),
    String(row.data_scope || '').trim(),
    String(row.data_group || '').trim(),
    String(row.data_key || '').trim()
  ].join('|');
  if (!compositeKey.replace(/\|/g, '')) return;
  const current = userDataRowsByKey.get(compositeKey);
  if (!current || shouldReplaceCanonicalUserDataRow(current, row)) {
    userDataRowsByKey.set(compositeKey, row);
  }
}

function createCanonicalUserDataRow({
  stableKey = '',
  userId = '',
  scope = '',
  group = '',
  key = '',
  payload = null,
  updatedAtMs = 0,
  deletedAtMs = null,
  sourcePath = '/backfill',
  requestId = '',
  occurredAtIso = '',
  opId = null
} = {}) {
  const normalizedUpdatedAtMs = normalizeMs(updatedAtMs) || Date.now();
  const normalizedDeletedAtMs = deletedAtMs === null || typeof deletedAtMs === 'undefined'
    ? null
    : (normalizeMs(deletedAtMs) || normalizedUpdatedAtMs);
  const normalizedOccurredAtIso = normalizeIso(occurredAtIso) || isoFromMs(normalizedUpdatedAtMs, normalizedDeletedAtMs);
  const normalizedPayload = normalizePayloadObject(payload);
  const normalizedGroup = String(group || '').trim() || 'unknown';
  const normalizedKey = String(key || '').trim() || 'unknown';

  return {
    user_id: String(userId || '').trim(),
    sector_key: normalizedGroup,
    item_key: normalizedKey,
    item_json: normalizedPayload,
    source_event_id: deterministicUuidFrom(String(stableKey || `${userId}:${scope}:${group}:${key}`)),
    occurred_at: normalizedOccurredAtIso,
    data_scope: String(scope || '').trim() || 'unknown',
    data_group: normalizedGroup,
    data_key: normalizedKey,
    op_id: opId ? String(opId).slice(0, 120) : null,
    payload_json: normalizedPayload,
    updated_at_ms: normalizedUpdatedAtMs,
    deleted_at_ms: normalizedDeletedAtMs,
    source_path: String(sourcePath || '').trim() || '/backfill',
    request_id: String(requestId || '').trim() || null,
    source: 'data-api-backfill',
    updated_at: BACKFILLED_AT_ISO
  };
}

function shouldReplaceCanonicalUserDataRow(currentRow, nextRow) {
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

async function postRows({ table, rows, onConflict }) {
  if (!Array.isArray(rows) || !rows.length) {
    console.log(`BACKFILL_POST_SKIPPED ${table} rows=0`);
    return;
  }
  const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?on_conflict=${encodeURIComponent(onConflict)}`;
  let postedRows = 0;
  for (let idx = 0; idx < rows.length; idx += POST_BATCH_SIZE) {
    const batch = rows.slice(idx, idx + POST_BATCH_SIZE);
    await postToSupabase(url, batch);
    postedRows += batch.length;
    console.log(`BACKFILL_POSTED ${table} ${postedRows}/${rows.length}`);
  }
}

function runWranglerD1Query(sql) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const raw = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "& $env:BACKFILL_WRANGLER_BIN d1 execute $env:BACKFILL_D1_NAME --remote --command $env:BACKFILL_SQL --json"
        ],
        {
          encoding: 'utf8',
          maxBuffer: 50 * 1024 * 1024,
          env: {
            ...process.env,
            BACKFILL_WRANGLER_BIN: WRANGLER_BIN,
            BACKFILL_D1_NAME: D1_DB_NAME,
            BACKFILL_SQL: sql
          }
        }
      );
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed[0] || !Array.isArray(parsed[0].results)) {
        throw new Error('Unexpected D1 JSON output shape.');
      }
      return parsed[0].results;
    } catch (error) {
      lastError = error;
      const msg = String(error?.stderr || error?.message || error);
      const retryable = /Authentication error|timed out|ETIMEDOUT|ECONNRESET|429|5\d\d/.test(msg);
      if (!retryable || attempt === 3) break;
      console.warn(`D1 query retrying (${attempt}/3)`);
    }
  }
  throw lastError;
}

async function postToSupabase(url, rows) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'content-type': 'application/json',
          prefer: 'resolution=merge-duplicates,return=minimal,missing=default'
        },
        body: JSON.stringify(rows)
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Supabase POST failed (${response.status}): ${text.slice(0, 300)}`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
      console.warn(`Supabase batch retrying (${attempt}/3): ${String(error?.message || error)}`);
    }
  }
  throw lastError;
}

function normalizeUserId(value) {
  return String(value || '').trim();
}

function normalizePayloadObject(value, { fallbackText = '' } = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  const text = String(fallbackText || '').trim();
  if (!text) return null;
  return {
    rawText: text
  };
}

function safeJsonParse(input, fallback = null) {
  try {
    return JSON.parse(String(input || ''));
  } catch {
    return fallback;
  }
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function normalizeIso(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function isoFromMs(...values) {
  for (const value of values) {
    const ms = normalizeMs(value);
    if (ms) return new Date(ms).toISOString();
  }
  return BACKFILLED_AT_ISO;
}

function deterministicUuidFrom(input) {
  const hash = createHash('sha1').update(String(input || '')).digest();
  const bytes = Uint8Array.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function resolveWranglerBin() {
  const explicit = String(process.env.BACKFILL_WRANGLER_BIN || '').trim();
  if (explicit) return explicit;
  const localBin = path.join(
    process.cwd(),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'
  );
  if (existsSync(localBin)) return localBin;
  return process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler';
}

#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const D1_DB_NAME = process.env.BACKFILL_D1_DB_NAME || 'bilm-data';
const SUPABASE_URL = String(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const SUPABASE_TABLE = String(process.env.SUPABASE_MIRROR_TABLE || 'cloudflare_mirror_events').trim();
const PAGE_SIZE = clampInt(process.env.BACKFILL_PAGE_SIZE, 200, 25, 1000);
const POST_BATCH_SIZE = clampInt(process.env.BACKFILL_POST_BATCH_SIZE, 20, 1, 200);
const MAX_ROWS_PER_TABLE = clampInt(process.env.BACKFILL_MAX_ROWS_PER_TABLE, 0, 0, 5_000_000);
const DRY_RUN = String(process.env.BACKFILL_DRY_RUN || '').trim() === '1';
const WRANGLER_BIN = resolveWranglerBin();

if (!SUPABASE_URL) {
  throw new Error('Missing SUPABASE_URL (or SUPABASE_PROJECT_URL).');
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY.');
}

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
    mapRow: (row) => {
      const snapshot = safeJsonParse(row.snapshot_json, row.snapshot_json);
      const requestBody = {
        userId: row.user_id,
        data: snapshot,
        backfill: true,
        sourceTable: 'user_snapshots',
        meta: {
          updatedAtMs: normalizeMs(row.updated_at_ms),
          deviceId: row.device_id || null,
          schema: row.schema || null,
          savedAt: normalizeIso(row.saved_at)
        }
      };
      return buildMirrorEvent({
        stableKey: `user_snapshots:${row.user_id}`,
        path: '/',
        userId: row.user_id,
        occurredAtIso: normalizeIso(row.saved_at) || isoFromMs(row.updated_at_ms),
        requestBody,
        responseBody: {
          ok: true,
          saved: true,
          source: 'd1-backfill'
        }
      });
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
    mapRow: (row) => {
      const itemPayload = safeJsonParse(row.item_json, row.item_json);
      const requestBody = {
        userId: row.user_id,
        operations: [
          {
            sectorKey: row.sector_key,
            itemKey: row.item_key,
            item: itemPayload,
            updatedAtMs: normalizeMs(row.updated_at_ms),
            deletedAtMs: normalizeMs(row.deleted_at_ms),
            deviceId: row.device_id || null,
            opId: row.op_id || null
          }
        ],
        backfill: true,
        sourceTable: 'sync_items'
      };
      return buildMirrorEvent({
        stableKey: `sync_items:${row.user_id}:${row.sector_key}:${row.item_key}`,
        path: '/sync/sectors/push',
        userId: row.user_id,
        occurredAtIso: normalizeIso(row.saved_at) || isoFromMs(row.updated_at_ms),
        requestBody,
        responseBody: {
          ok: true,
          pushed: 1,
          source: 'd1-backfill'
        }
      });
    }
  },
  {
    table: 'account_links',
    orderBy: 'id',
    select: [
      'id',
      'status',
      'requester_user_id',
      'requester_email',
      'target_user_id',
      'target_email',
      'requester_share_scopes_json',
      'target_share_scopes_json',
      'requester_approved_at_ms',
      'target_approved_at_ms',
      'created_at_ms',
      'updated_at_ms',
      'activated_at_ms',
      'declined_at_ms',
      'unlinked_at_ms'
    ],
    mapRow: (row) => {
      const requestBody = {
        userId: row.requester_user_id,
        link: {
          ...row,
          requester_share_scopes_json: safeJsonParse(row.requester_share_scopes_json, row.requester_share_scopes_json),
          target_share_scopes_json: safeJsonParse(row.target_share_scopes_json, row.target_share_scopes_json)
        },
        backfill: true,
        sourceTable: 'account_links'
      };
      return buildMirrorEvent({
        stableKey: `account_links:${row.id}`,
        path: '/links/request',
        userId: row.requester_user_id,
        occurredAtIso: isoFromMs(row.updated_at_ms, row.created_at_ms),
        requestBody,
        responseBody: {
          ok: true,
          accountFound: Boolean(row.target_user_id),
          backfill: true
        }
      });
    }
  },
  {
    table: 'account_user_capabilities',
    orderBy: 'user_id',
    select: [
      'user_id',
      'email',
      'chat_ready',
      'last_chat_seen_at_ms',
      'updated_at_ms'
    ],
    mapRow: (row) => {
      const requestBody = {
        userId: row.user_id,
        capability: {
          email: row.email,
          chatReady: toBool(row.chat_ready),
          lastChatSeenAtMs: normalizeMs(row.last_chat_seen_at_ms),
          updatedAtMs: normalizeMs(row.updated_at_ms)
        },
        backfill: true,
        sourceTable: 'account_user_capabilities'
      };
      return buildMirrorEvent({
        stableKey: `account_user_capabilities:${row.user_id}`,
        path: '/links/chat-ready',
        userId: row.user_id,
        occurredAtIso: isoFromMs(row.updated_at_ms),
        requestBody,
        responseBody: {
          ok: true,
          deprecated: true,
          userId: row.user_id,
          chatReady: toBool(row.chat_ready),
          backfill: true
        }
      });
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
    mapRow: (row) => {
      const requestBody = {
        userId: row.user_id,
        state: {
          migratedAtMs: normalizeMs(row.migrated_at_ms),
          migrationSource: row.migration_source || null,
          updatedAtMs: normalizeMs(row.updated_at_ms),
          savedAt: normalizeIso(row.saved_at)
        },
        backfill: true,
        sourceTable: 'user_sync_state'
      };
      return buildMirrorEvent({
        stableKey: `user_sync_state:${row.user_id}`,
        path: '/sync/sectors/push',
        userId: row.user_id,
        occurredAtIso: normalizeIso(row.saved_at) || isoFromMs(row.updated_at_ms),
        requestBody,
        responseBody: {
          ok: true,
          pushed: 1,
          source: 'd1-backfill'
        }
      });
    }
  }
];

const allEvents = [];
for (const spec of tableSpecs) {
  const rows = fetchAllRows(spec);
  const mapped = rows.map(spec.mapRow);
  allEvents.push(...mapped);
  console.log(`BACKFILL_TABLE ${spec.table} rows=${rows.length} events=${mapped.length}`);
}

console.log(`BACKFILL_EVENTS_PREPARED=${allEvents.length}`);
if (!allEvents.length) {
  process.exit(0);
}

if (DRY_RUN) {
  console.log('BACKFILL_DRY_RUN=1 (no writes sent)');
  process.exit(0);
}

const mirrorUrl = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(SUPABASE_TABLE)}?on_conflict=event_id`;
let postedEvents = 0;
for (let idx = 0; idx < allEvents.length; idx += POST_BATCH_SIZE) {
  const batch = allEvents.slice(idx, idx + POST_BATCH_SIZE);
  await postToSupabase(mirrorUrl, batch);
  postedEvents += batch.length;
  console.log(`BACKFILL_POSTED ${postedEvents}/${allEvents.length}`);
}

console.log(`BACKFILL_DONE total=${allEvents.length}`);

function buildMirrorEvent({
  stableKey,
  path,
  userId,
  occurredAtIso,
  requestBody,
  responseBody
}) {
  const eventId = deterministicUuidFrom(stableKey);
  return {
    event_id: eventId,
    idempotency_key: eventId,
    source: 'd1-backfill',
    occurred_at: occurredAtIso || new Date().toISOString(),
    mirrored_at: new Date().toISOString(),
    user_id: String(userId || '').trim() || null,
    method: 'POST',
    path: String(path || '').trim() || '/backfill',
    query_params: {},
    request_headers: {
      'x-request-id': `backfill-${eventId}`
    },
    request_content_type: 'application/json',
    request_body_json: requestBody,
    request_body_text: null,
    request_body_bytes: jsonByteLength(requestBody),
    response_status: 200,
    response_content_type: 'application/json',
    response_body_json: responseBody,
    response_body_text: null,
    response_body_bytes: jsonByteLength(responseBody),
    retry_count: 0
  };
}

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

async function postToSupabase(url, events) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'content-type': 'application/json',
          prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(events)
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

function deterministicUuidFrom(input) {
  const hash = createHash('sha1').update(String(input || '')).digest();
  const bytes = Uint8Array.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function safeJsonParse(input, fallback = null) {
  try {
    return JSON.parse(String(input || ''));
  } catch {
    return fallback;
  }
}

function jsonByteLength(value) {
  const text = JSON.stringify(value ?? null);
  return Buffer.byteLength(text, 'utf8');
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
  return new Date().toISOString();
}

function toBool(value) {
  if (typeof value === 'boolean') return value;
  const num = Number(value);
  return Number.isFinite(num) ? num > 0 : Boolean(value);
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

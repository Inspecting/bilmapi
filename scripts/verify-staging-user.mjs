#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { existsSync } from 'node:fs';

const USER_ID = String(process.env.VERIFY_USER_ID || '').trim();
const D1_DB_NAME = String(process.env.VERIFY_D1_DB_NAME || 'bilm-data-staging').trim();
const SUPABASE_URL = String(process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

if (!USER_ID) {
  throw new Error('Missing VERIFY_USER_ID. Example: VERIFY_USER_ID=abc123 npm run verify:staging-user');
}
if (!SUPABASE_URL) {
  throw new Error('Missing SUPABASE_URL (or SUPABASE_PROJECT_URL).');
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY.');
}

const WRANGLER_BIN = resolveWranglerBin();

const d1SnapshotRows = readD1Scalar(`
  SELECT COUNT(*) AS count
  FROM user_snapshots
  WHERE user_id = '${escapeSqlLiteral(USER_ID)}';
`);
const d1ListRows = readD1Scalar(`
  SELECT COUNT(*) AS count
  FROM list_sync_items
  WHERE user_id = '${escapeSqlLiteral(USER_ID)}';
`);
const d1SectorRows = readD1Scalar(`
  SELECT COUNT(*) AS count
  FROM sync_items
  WHERE user_id = '${escapeSqlLiteral(USER_ID)}';
`);

const mirrorEvents = await fetchSupabaseCount({
  table: 'cloudflare_mirror_events',
  filters: [`user_id=eq.${encodeURIComponent(USER_ID)}`]
});
const profileRows = await fetchSupabaseCount({
  table: 'bilm_profiles',
  filters: [`user_id=eq.${encodeURIComponent(USER_ID)}`]
});
const userDataRows = await fetchSupabaseCount({
  table: 'bilm_user_data',
  filters: [`user_id=eq.${encodeURIComponent(USER_ID)}`]
});
const userDataDeletedRows = await fetchSupabaseCount({
  table: 'bilm_user_data',
  filters: [`user_id=eq.${encodeURIComponent(USER_ID)}`, 'deleted_at_ms=not.is.null']
});

console.log(JSON.stringify({
  ok: true,
  checkedAt: new Date().toISOString(),
  userId: USER_ID,
  d1: {
    database: D1_DB_NAME,
    snapshots: d1SnapshotRows,
    listItems: d1ListRows,
    sectorItems: d1SectorRows
  },
  supabase: {
    projectUrl: SUPABASE_URL,
    mirrorEvents,
    profiles: profileRows,
    userData: userDataRows,
    userDataDeleted: userDataDeletedRows
  }
}, null, 2));

function readD1Scalar(sql) {
  const output = execFileSync(
    process.platform === 'win32' ? 'powershell' : 'sh',
    process.platform === 'win32'
      ? [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "& $env:VERIFY_WRANGLER_BIN d1 execute $env:VERIFY_D1_DB_NAME --remote --command $env:VERIFY_SQL --json"
      ]
      : [
        '-lc',
        '"$VERIFY_WRANGLER_BIN" d1 execute "$VERIFY_D1_DB_NAME" --remote --command "$VERIFY_SQL" --json'
      ],
    {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        VERIFY_WRANGLER_BIN: WRANGLER_BIN,
        VERIFY_D1_DB_NAME: D1_DB_NAME,
        VERIFY_SQL: compactSql(sql)
      }
    }
  );
  const parsed = JSON.parse(output);
  const firstBatch = Array.isArray(parsed) ? parsed[0] : null;
  const firstRow = firstBatch && Array.isArray(firstBatch.results) ? firstBatch.results[0] : null;
  return Number(firstRow?.count || 0) || 0;
}

async function fetchSupabaseCount({ table, filters = [] }) {
  const queryParts = ['select=*', ...filters];
  const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?${queryParts.join('&')}`;
  const response = await fetch(url, {
    method: 'HEAD',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      prefer: 'count=exact'
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Supabase count failed for ${table} (${response.status}): ${text.slice(0, 200)}`);
  }
  const rangeHeader = String(response.headers.get('content-range') || '');
  const match = /\/(\d+)\s*$/.exec(rangeHeader);
  if (!match) return 0;
  return Number(match[1] || 0) || 0;
}

function resolveWranglerBin() {
  const explicit = String(process.env.VERIFY_WRANGLER_BIN || '').trim();
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

function compactSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function escapeSqlLiteral(value) {
  return String(value || '').replace(/'/g, "''");
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorker } from '../src/index.js';

const USER_ID = '12345678901234567890123456';
const OTHER_USER_ID = 'abcdefghijklmnopqrstuvwxyz12';
const THIRD_USER_ID = '33333333333333333333333333';
const GMAIL_USER_ID = '44444444444444444444444444';
const ALLOWED_ORIGIN = 'https://watchbilm.org';
const ALLOWED_FLY_ORIGIN = 'https://bilm.fly.dev';
const DISALLOWED_ORIGIN = 'https://evil.example';
const SYNC_FUTURE_TIME_WINDOW_MS = 10 * 60 * 1000;

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

  async delete(key) {
    this.map.delete(String(key));
  }
}

class MemoryR2Object {
  constructor(value) {
    this.value = String(value || '');
  }

  async text() {
    return this.value;
  }

  async arrayBuffer() {
    return new TextEncoder().encode(this.value).buffer;
  }
}

class MemoryR2 {
  constructor() {
    this.map = new Map();
  }

  async put(key, value) {
    this.map.set(String(key), String(value || ''));
  }

  async get(key) {
    const value = this.map.get(String(key));
    if (typeof value === 'undefined') return null;
    return new MemoryR2Object(value);
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
      const incomingDeletedAtMs = deletedAtMs === null || typeof deletedAtMs === 'undefined'
        ? 0
        : (Number(deletedAtMs || 0) || 0);
      const current = this.db.listRows.get(compositeKey);
      if (current) {
        const currentUpdatedAt = Number(current.updated_at_ms || 0) || 0;
        const currentDeletedAtMs = current.deleted_at_ms === null || typeof current.deleted_at_ms === 'undefined'
          ? 0
          : (Number(current.deleted_at_ms || 0) || 0);
        const staleByTime = incomingUpdatedAt < currentUpdatedAt;
        const staleByDeletePriority = incomingUpdatedAt === currentUpdatedAt
          && incomingDeletedAtMs < currentDeletedAtMs;
        if (staleByTime || staleByDeletePriority) {
          return { success: true, meta: { changes: 0 } };
        }
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

    if (this.sql.startsWith('insert into sync_items')) {
      const [userId, sectorKey, itemKey, itemJson, updatedAtMs, deletedAtMs, deviceId, opId, savedAt] = this.params;
      const normalizedUserId = String(userId || '');
      const normalizedSectorKey = String(sectorKey || '');
      const normalizedItemKey = String(itemKey || '');
      const compositeKey = `${normalizedUserId}|${normalizedSectorKey}|${normalizedItemKey}`;
      const incomingUpdatedAt = Number(updatedAtMs || 0) || 0;
      const incomingOpId = String(opId || '');
      const incomingDeletedAtMs = deletedAtMs === null || typeof deletedAtMs === 'undefined'
        ? 0
        : (Number(deletedAtMs || 0) || 0);
      const current = this.db.syncRows.get(compositeKey);
      if (current) {
        const currentUpdatedAt = Number(current.updated_at_ms || 0) || 0;
        const currentOpId = String(current.op_id || '');
        const currentDeletedAtMs = current.deleted_at_ms === null || typeof current.deleted_at_ms === 'undefined'
          ? 0
          : (Number(current.deleted_at_ms || 0) || 0);
        const staleByTime = incomingUpdatedAt < currentUpdatedAt;
        const staleByDeletePriority = incomingUpdatedAt === currentUpdatedAt
          && incomingDeletedAtMs < currentDeletedAtMs;
        const staleByOpId = incomingUpdatedAt === currentUpdatedAt
          && incomingDeletedAtMs === currentDeletedAtMs
          && incomingOpId < currentOpId;
        if (staleByTime || staleByOpId) {
          return { success: true, meta: { changes: 0 } };
        }
        if (staleByDeletePriority) {
          return { success: true, meta: { changes: 0 } };
        }
      }
      this.db.syncRows.set(compositeKey, {
        user_id: normalizedUserId,
        sector_key: normalizedSectorKey,
        item_key: normalizedItemKey,
        item_json: itemJson === null || typeof itemJson === 'undefined' ? null : String(itemJson),
        updated_at_ms: incomingUpdatedAt,
        deleted_at_ms: deletedAtMs === null || typeof deletedAtMs === 'undefined'
          ? null
          : (Number(deletedAtMs || 0) || 0),
        device_id: deviceId || null,
        op_id: incomingOpId || null,
        saved_at: String(savedAt || '')
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (this.sql.startsWith('insert into user_sync_state')) {
      const [userId, migratedAtMs, migrationSource, updatedAtMs, savedAt] = this.params;
      const normalizedUserId = String(userId || '');
      const current = this.db.syncStateRows.get(normalizedUserId);
      this.db.syncStateRows.set(normalizedUserId, {
        user_id: normalizedUserId,
        migrated_at_ms: current?.migrated_at_ms || (Number(migratedAtMs || 0) || null),
        migration_source: current?.migration_source || (String(migrationSource || '').trim() || null),
        updated_at_ms: Number(updatedAtMs || 0) || 0,
        saved_at: String(savedAt || '')
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (this.sql.startsWith('insert into account_user_capabilities')) {
      const [userId, email, chatReady, lastChatSeenAtMs, updatedAtMs] = this.params;
      const normalizedUserId = String(userId || '');
      const current = this.db.accountCapabilityRows.get(normalizedUserId);
      this.db.accountCapabilityRows.set(normalizedUserId, {
        user_id: normalizedUserId,
        email: String(email || '').toLowerCase(),
        chat_ready: Math.max(Number(current?.chat_ready || 0) || 0, Number(chatReady || 0) || 0),
        last_chat_seen_at_ms: lastChatSeenAtMs === null || typeof lastChatSeenAtMs === 'undefined'
          ? current?.last_chat_seen_at_ms || null
          : Number(lastChatSeenAtMs || 0) || null,
        updated_at_ms: Number(updatedAtMs || 0) || 0
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (this.sql.startsWith('insert into account_links')) {
      const [
        id,
        status,
        requesterUserId,
        requesterEmail,
        targetUserId,
        targetEmail,
        requesterShareScopesJson,
        targetShareScopesJson,
        requesterApprovedAtMs,
        targetApprovedAtMs,
        createdAtMs,
        updatedAtMs,
        activatedAtMs,
        declinedAtMs,
        unlinkedAtMs
      ] = this.params;
      const row = {
        id: String(id || ''),
        status: String(status || '').toLowerCase(),
        requester_user_id: String(requesterUserId || ''),
        requester_email: String(requesterEmail || '').toLowerCase(),
        target_user_id: targetUserId === null || typeof targetUserId === 'undefined' ? null : String(targetUserId || ''),
        target_email: String(targetEmail || '').toLowerCase(),
        requester_share_scopes_json: String(requesterShareScopesJson || '{}'),
        target_share_scopes_json: String(targetShareScopesJson || '{}'),
        requester_approved_at_ms: requesterApprovedAtMs === null || typeof requesterApprovedAtMs === 'undefined'
          ? null
          : Number(requesterApprovedAtMs || 0) || null,
        target_approved_at_ms: targetApprovedAtMs === null || typeof targetApprovedAtMs === 'undefined'
          ? null
          : Number(targetApprovedAtMs || 0) || null,
        created_at_ms: Number(createdAtMs || 0) || 0,
        updated_at_ms: Number(updatedAtMs || 0) || 0,
        activated_at_ms: activatedAtMs === null || typeof activatedAtMs === 'undefined'
          ? null
          : Number(activatedAtMs || 0) || null,
        declined_at_ms: declinedAtMs === null || typeof declinedAtMs === 'undefined'
          ? null
          : Number(declinedAtMs || 0) || null,
        unlinked_at_ms: unlinkedAtMs === null || typeof unlinkedAtMs === 'undefined'
          ? null
          : Number(unlinkedAtMs || 0) || null
      };
      this.db.accountLinkRows.set(row.id, row);
      return { success: true, meta: { changes: 1 } };
    }

    if (this.sql.startsWith('insert into media_cache_entries')) {
      const [
        cacheKey,
        provider,
        resourceType,
        queryText,
        statusCode,
        contentType,
        payloadInlineJson,
        payloadR2Key,
        fetchedAtMs,
        expiresAtMs,
        staleUntilMs,
        hitCount,
        lastHitAtMs
      ] = this.params;
      const normalizedCacheKey = String(cacheKey || '');
      this.db.mediaRows.set(normalizedCacheKey, {
        cache_key: normalizedCacheKey,
        provider: String(provider || ''),
        resource_type: String(resourceType || ''),
        query_text: queryText === null || typeof queryText === 'undefined' ? null : String(queryText),
        status_code: Number(statusCode || 0) || 200,
        content_type: String(contentType || ''),
        payload_inline_json: payloadInlineJson === null || typeof payloadInlineJson === 'undefined'
          ? null
          : String(payloadInlineJson),
        payload_r2_key: payloadR2Key === null || typeof payloadR2Key === 'undefined'
          ? null
          : String(payloadR2Key),
        fetched_at_ms: Number(fetchedAtMs || 0) || 0,
        expires_at_ms: Number(expiresAtMs || 0) || 0,
        stale_until_ms: Number(staleUntilMs || 0) || 0,
        hit_count: Number(hitCount || 0) || 0,
        last_hit_at_ms: Number(lastHitAtMs || 0) || 0
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (this.sql.startsWith('update media_cache_entries')) {
      const [cacheKey, lastHitAtMs] = this.params;
      const key = String(cacheKey || '');
      const current = this.db.mediaRows.get(key);
      if (!current) return { success: true, meta: { changes: 0 } };
      current.hit_count = (Number(current.hit_count || 0) || 0) + 1;
      current.last_hit_at_ms = Number(lastHitAtMs || 0) || 0;
      this.db.mediaRows.set(key, current);
      return { success: true, meta: { changes: 1 } };
    }

    if (this.sql.startsWith('insert into media_query_metrics')) {
      const [provider, resourceType, queryText, lastSeenAtMs] = this.params;
      const key = `${String(provider || '')}|${String(resourceType || '')}|${String(queryText || '')}`;
      const current = this.db.mediaQueryRows.get(key);
      this.db.mediaQueryRows.set(key, {
        provider: String(provider || ''),
        resource_type: String(resourceType || ''),
        query_text: String(queryText || ''),
        hit_count: (Number(current?.hit_count || 0) || 0) + 1,
        last_seen_at_ms: Number(lastSeenAtMs || 0) || 0
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (this.sql.startsWith('insert into media_refresh_locks')) {
      const [cacheKey, ownerId, lockUntilMs, updatedAtMs, lockCutoffMs] = this.params;
      const normalizedCacheKey = String(cacheKey || '');
      const current = this.db.mediaLocks.get(normalizedCacheKey);
      const currentUntil = Number(current?.lock_until_ms || 0) || 0;
      const cutoff = Number(lockCutoffMs || 0) || 0;
      if (current && currentUntil >= cutoff) {
        return { success: true, meta: { changes: 0 } };
      }
      this.db.mediaLocks.set(normalizedCacheKey, {
        cache_key: normalizedCacheKey,
        owner_id: String(ownerId || ''),
        lock_until_ms: Number(lockUntilMs || 0) || 0,
        updated_at_ms: Number(updatedAtMs || 0) || 0
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (this.sql.startsWith('delete from user_snapshots')) {
      const userId = String(this.params[0] || '');
      const had = this.db.rows.delete(userId);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }

    if (this.sql.startsWith('delete from sync_items')) {
      if (this.sql.includes('where user_id = ?1')) {
        const userId = String(this.params[0] || '');
        let deleted = 0;
        for (const [key, row] of this.db.syncRows.entries()) {
          if (String(row.user_id || '') === userId) {
            this.db.syncRows.delete(key);
            deleted += 1;
          }
        }
        return { success: true, meta: { changes: deleted } };
      }
      const cutoffMs = Number(this.params[0] || 0) || 0;
      let deleted = 0;
      for (const [key, row] of this.db.syncRows.entries()) {
        const deletedAtMs = Number(row.deleted_at_ms || 0) || 0;
        if (deletedAtMs > 0 && deletedAtMs < cutoffMs) {
          this.db.syncRows.delete(key);
          deleted += 1;
        }
      }
      return { success: true, meta: { changes: deleted } };
    }

    if (this.sql.startsWith('delete from media_refresh_locks where cache_key')) {
      const [cacheKey, ownerId] = this.params;
      const normalizedCacheKey = String(cacheKey || '');
      const lock = this.db.mediaLocks.get(normalizedCacheKey);
      if (!lock) return { success: true, meta: { changes: 0 } };
      if (String(lock.owner_id || '') !== String(ownerId || '')) {
        return { success: true, meta: { changes: 0 } };
      }
      this.db.mediaLocks.delete(normalizedCacheKey);
      return { success: true, meta: { changes: 1 } };
    }

    if (this.sql.startsWith('delete from media_cache_entries')) {
      const cutoffMs = Number(this.params[0] || 0) || 0;
      let deleted = 0;
      for (const [key, row] of this.db.mediaRows.entries()) {
        const staleUntilMs = Number(row.stale_until_ms || 0) || 0;
        if (staleUntilMs > 0 && staleUntilMs < cutoffMs) {
          this.db.mediaRows.delete(key);
          deleted += 1;
        }
      }
      return { success: true, meta: { changes: deleted } };
    }

    if (this.sql.startsWith('delete from media_refresh_locks where lock_until_ms')) {
      const cutoffMs = Number(this.params[0] || 0) || 0;
      let deleted = 0;
      for (const [key, row] of this.db.mediaLocks.entries()) {
        const lockUntilMs = Number(row.lock_until_ms || 0) || 0;
        if (lockUntilMs > 0 && lockUntilMs < cutoffMs) {
          this.db.mediaLocks.delete(key);
          deleted += 1;
        }
      }
      return { success: true, meta: { changes: deleted } };
    }

    if (this.sql.startsWith('delete from list_sync_items')) {
      if (this.sql.includes('where user_id = ?1')) {
        const userId = String(this.params[0] || '');
        let deleted = 0;
        for (const [key, row] of this.db.listRows.entries()) {
          if (String(row.user_id || '') === userId) {
            this.db.listRows.delete(key);
            deleted += 1;
          }
        }
        return { success: true, meta: { changes: deleted } };
      }
      const cutoffMs = Number(this.params[0] || 0) || 0;
      let deleted = 0;
      for (const [key, row] of this.db.listRows.entries()) {
        const deletedAtMs = Number(row.deleted_at_ms || 0) || 0;
        if (deletedAtMs > 0 && deletedAtMs < cutoffMs) {
          this.db.listRows.delete(key);
          deleted += 1;
        }
      }
      return { success: true, meta: { changes: deleted } };
    }

    if (this.sql.startsWith('delete from user_sync_state')) {
      const userId = String(this.params[0] || '');
      const had = this.db.syncStateRows.delete(userId);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }

    if (this.sql.startsWith('delete from account_links')) {
      const userId = String(this.params[0] || '');
      const email = String(this.params[1] || '').toLowerCase();
      let deleted = 0;
      for (const [key, row] of this.db.accountLinkRows.entries()) {
        const requesterUserId = String(row.requester_user_id || '');
        const targetUserId = String(row.target_user_id || '');
        const requesterEmail = String(row.requester_email || '').toLowerCase();
        const targetEmail = String(row.target_email || '').toLowerCase();
        if (
          requesterUserId === userId
          || targetUserId === userId
          || requesterEmail === email
          || targetEmail === email
        ) {
          this.db.accountLinkRows.delete(key);
          deleted += 1;
        }
      }
      return { success: true, meta: { changes: deleted } };
    }

    if (this.sql.startsWith('delete from account_user_capabilities')) {
      const userId = String(this.params[0] || '');
      const email = String(this.params[1] || '').toLowerCase();
      let deleted = 0;
      for (const [key, row] of this.db.accountCapabilityRows.entries()) {
        const rowUserId = String(row.user_id || '');
        const rowEmail = String(row.email || '').toLowerCase();
        if (rowUserId === userId || rowEmail === email) {
          this.db.accountCapabilityRows.delete(key);
          deleted += 1;
        }
      }
      return { success: true, meta: { changes: deleted } };
    }

    throw new Error(`Unsupported D1 run SQL in test: ${this.sql}`);
  }

  async first() {
    const key = String(this.params[0] || '');
    if (this.sql.includes('from account_user_capabilities')) {
      const emails = this.params
        .map((value) => String(value || '').toLowerCase())
        .filter((value) => value.includes('@'));
      const rows = [...this.db.accountCapabilityRows.values()]
        .filter((row) => emails.includes(String(row.email || '').toLowerCase()))
        .sort((a, b) => Number(b.updated_at_ms || 0) - Number(a.updated_at_ms || 0));
      return rows[0] ? { ...rows[0] } : null;
    }

    if (this.sql.includes('from account_links') && this.sql.includes('where id = ?1')) {
      const row = this.db.accountLinkRows.get(key);
      return row ? { ...row } : null;
    }

    if (this.sql.includes('from account_links') && this.sql.includes("status in ('pending', 'active')")) {
      const excluded = String(this.params[this.params.length - 1] || '');
      const actorUserIds = this.params
        .slice(0, -1)
        .map((value) => String(value || '').trim())
        .filter((value) => value && !value.includes('@'));
      const actorEmails = this.params
        .slice(0, -1)
        .map((value) => String(value || '').toLowerCase().trim())
        .filter((value) => value.includes('@'));
      const row = [...this.db.accountLinkRows.values()].find((entry) => {
        if (String(entry.id || '') === excluded) return false;
        if (!['pending', 'active'].includes(String(entry.status || ''))) return false;
        const requesterUserId = String(entry.requester_user_id || '');
        const targetUserId = String(entry.target_user_id || '');
        const requesterEmail = String(entry.requester_email || '').toLowerCase();
        const targetEmail = String(entry.target_email || '').toLowerCase();
        return actorUserIds.includes(requesterUserId)
          || actorUserIds.includes(targetUserId)
          || actorEmails.includes(requesterEmail)
          || actorEmails.includes(targetEmail);
      });
      return row ? { ...row } : null;
    }

    if (this.sql.includes('select migrated_at_ms')) {
      const syncState = this.db.syncStateRows.get(key);
      if (!syncState) return null;
      return {
        migrated_at_ms: syncState.migrated_at_ms,
        migration_source: syncState.migration_source,
        updated_at_ms: syncState.updated_at_ms
      };
    }

    if (this.sql.includes('from media_cache_entries')) {
      const mediaRow = this.db.mediaRows.get(key);
      if (!mediaRow) return null;
      return {
        cache_key: mediaRow.cache_key,
        provider: mediaRow.provider,
        resource_type: mediaRow.resource_type,
        status_code: mediaRow.status_code,
        content_type: mediaRow.content_type,
        payload_inline_json: mediaRow.payload_inline_json,
        payload_r2_key: mediaRow.payload_r2_key,
        fetched_at_ms: mediaRow.fetched_at_ms,
        expires_at_ms: mediaRow.expires_at_ms,
        stale_until_ms: mediaRow.stale_until_ms,
        hit_count: mediaRow.hit_count,
        last_hit_at_ms: mediaRow.last_hit_at_ms
      };
    }

    const row = this.db.rows.get(key);
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
    if (this.sql.includes('from account_links')) {
      const userIds = this.params
        .map((value) => String(value || '').trim())
        .filter((value) => value && !value.includes('@'));
      const emails = this.params
        .map((value) => String(value || '').toLowerCase().trim())
        .filter((value) => value.includes('@'));
      const results = [...this.db.accountLinkRows.values()]
        .filter((row) => userIds.includes(String(row.requester_user_id || ''))
          || userIds.includes(String(row.target_user_id || ''))
          || emails.includes(String(row.requester_email || '').toLowerCase())
          || emails.includes(String(row.target_email || '').toLowerCase()))
        .sort((a, b) => Number(b.updated_at_ms || 0) - Number(a.updated_at_ms || 0))
        .slice(0, 50)
        .map((row) => ({ ...row }));
      return { results };
    }

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

    if (this.sql.includes('from sync_items')) {
      const [userId, sinceMsOrCursorMs] = this.params;
      const max = Number(this.params[this.params.length - 1] || 250) || 250;
      const normalizedUserId = String(userId || '');
      const useTupleCursor = this.sql.includes("coalesce(op_id, '') > ?3");
      const since = Number(sinceMsOrCursorMs || 0) || 0;
      const cursorOpId = useTupleCursor ? String(this.params[2] || '') : '';
      const cursorSectorKey = useTupleCursor ? String(this.params[3] || '') : '';
      const cursorItemKey = useTupleCursor ? String(this.params[4] || '') : '';
      const sectorFilters = this.params
        .slice(useTupleCursor ? 5 : 2, this.params.length - 1)
        .map((entry) => String(entry || ''))
        .filter(Boolean);
      const results = [...this.db.syncRows.values()]
        .filter((row) => {
          if (row.user_id !== normalizedUserId) return false;
          const rowUpdatedAtMs = Number(row.updated_at_ms || 0) || 0;
          if (!useTupleCursor) {
            return rowUpdatedAtMs > since;
          }
          if (rowUpdatedAtMs > since) return true;
          if (rowUpdatedAtMs < since) return false;
          const rowOpId = String(row.op_id || '');
          if (rowOpId > cursorOpId) return true;
          if (rowOpId < cursorOpId) return false;
          const rowSectorKey = String(row.sector_key || '');
          if (rowSectorKey > cursorSectorKey) return true;
          if (rowSectorKey < cursorSectorKey) return false;
          const rowItemKey = String(row.item_key || '');
          return rowItemKey > cursorItemKey;
        })
        .filter((row) => !sectorFilters.length || sectorFilters.includes(String(row.sector_key || '')))
        .sort((a, b) => {
          const timeDiff = (Number(a.updated_at_ms || 0) || 0) - (Number(b.updated_at_ms || 0) || 0);
          if (timeDiff !== 0) return timeDiff;
          const opDiff = String(a.op_id || '').localeCompare(String(b.op_id || ''));
          if (opDiff !== 0) return opDiff;
          const sectorDiff = String(a.sector_key || '').localeCompare(String(b.sector_key || ''));
          if (sectorDiff !== 0) return sectorDiff;
          return String(a.item_key || '').localeCompare(String(b.item_key || ''));
        })
        .slice(0, Math.max(1, max))
        .map((row) => ({
          sector_key: row.sector_key,
          item_key: row.item_key,
          item_json: row.item_json,
          updated_at_ms: row.updated_at_ms,
          deleted_at_ms: row.deleted_at_ms,
          op_id: row.op_id
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
    this.syncRows = new Map();
    this.syncStateRows = new Map();
    this.mediaRows = new Map();
    this.mediaQueryRows = new Map();
    this.mediaLocks = new Map();
    this.accountCapabilityRows = new Map();
    this.accountLinkRows = new Map();
  }

  prepare(sql) {
    return new MemoryD1Statement(this, sql);
  }
}

function createEnv({
  kv = new MemoryKv(),
  d1 = new MemoryD1(),
  r2 = new MemoryR2(),
  disableAuth = false,
  authBypassToken = 'test-auth-bypass-token'
} = {}) {
  return {
    BILM_DATA: kv,
    BILM_DB: d1,
    BILM_R2: r2,
    FIREBASE_PROJECT_ID: 'bilm-7bfe1',
    BILM_ADMIN_TOKEN: 'top-secret-token',
    BILM_DISABLE_AUTH: disableAuth ? 'true' : 'false',
    BILM_AUTH_BYPASS_TOKEN: String(authBypassToken || ''),
    TMDB_API_KEY: 'tmdb-test-key',
    TMDB_READ_ACCESS_TOKEN: '',
    OMDB_API_KEY: 'omdb-test-key'
  };
}

function createVerifier() {
  return async (token) => {
    if (token === 'valid-token') return { sub: USER_ID, email: 'alice@example.com' };
    if (token === 'other-token') return { sub: OTHER_USER_ID, email: 'bob@example.com' };
    if (token === 'third-token') return { sub: THIRD_USER_ID, email: 'charlie@example.com' };
    if (token === 'gmail-token') return { sub: GMAIL_USER_ID, email: 'worldsforming@gmail.com' };
    throw new Error('invalid token');
  };
}

function enableSupabasePrimary(env) {
  env.SUPABASE_PROJECT_URL = 'https://example.supabase.co';
  env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  env.SUPABASE_CANONICAL_ENABLED = 'true';
  env.SUPABASE_CANONICAL_PRIMARY = 'true';
  env.SUPABASE_CANONICAL_PROFILE_TABLE = 'bilm_profiles';
  env.SUPABASE_CANONICAL_USER_DATA_TABLE = 'bilm_user_data';
}

describe('data api', () => {
  let kv;
  let d1;
  let r2;
  let env;
  let worker;

  beforeEach(() => {
    kv = new MemoryKv();
    d1 = new MemoryD1();
    r2 = new MemoryR2();
    env = createEnv({ kv, d1, r2 });
    worker = createWorker({ verifyIdToken: createVerifier() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('accepts legacy value payloads for snapshot save', async () => {
    const payload = {
      schema: 'bilm-backup-v1',
      meta: {
        updatedAtMs: 1711111111111,
        deviceId: 'device-legacy'
      },
      localStorage: {
        'bilm-watch-history': '[]'
      },
      sessionStorage: {}
    };

    const saveResponse = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token',
        origin: ALLOWED_ORIGIN
      },
      body: JSON.stringify({ userId: USER_ID, value: JSON.stringify(payload) })
    }), env);

    expect(saveResponse.status).toBe(200);
    const saveBody = await saveResponse.json();
    expect(saveBody.ok).toBe(true);
    expect(Number(saveBody.bytes || 0)).toBeGreaterThan(0);

    const loadResponse = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`, {
      method: 'GET',
      headers: {
        authorization: 'Bearer valid-token',
        origin: ALLOWED_ORIGIN
      }
    }), env);

    expect(loadResponse.status).toBe(200);
    const loaded = await loadResponse.json();
    expect(loaded.schema).toBe('bilm-backup-v1');
    expect(loaded.meta.deviceId).toBe('device-legacy');
  });

  it('accepts raw backup JSON as the snapshot save body', async () => {
    const payload = {
      userId: OTHER_USER_ID,
      schema: 'bilm-backup-v1',
      meta: {
        updatedAtMs: 1712222222222,
        deviceId: 'device-raw'
      },
      localStorage: {
        'bilm-favorites': '[]'
      },
      sessionStorage: {}
    };

    const saveResponse = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${OTHER_USER_ID}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer other-token',
        origin: ALLOWED_ORIGIN
      },
      body: JSON.stringify(payload)
    }), env);

    expect(saveResponse.status).toBe(200);
    const loaded = JSON.parse(d1.rows.get(OTHER_USER_ID).snapshot_json);
    expect(loaded.schema).toBe('bilm-backup-v1');
    expect(loaded.meta.deviceId).toBe('device-raw');
  });

  it('returns a user-friendly missing snapshot error', async () => {
    const response = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token',
        origin: ALLOWED_ORIGIN
      },
      body: JSON.stringify({ userId: USER_ID })
    }), env);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('missing_snapshot_data');
    expect(body.message).toContain('Cloud Export');
  });

  it('rejects oversized direct JSON bodies before auth and storage work', async () => {
    const response = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ALLOWED_ORIGIN
      },
      body: JSON.stringify({
        userId: USER_ID,
        data: {
          schema: 'bilm-backup-v1',
          blob: 'x'.repeat((2 * 1024 * 1024) + 1)
        }
      })
    }), env);

    expect(response.status).toBe(413);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    const body = await response.json();
    expect(body.code).toBe('payload_too_large');
  });

  it('rate limits private snapshot writes per user', async () => {
    env.BILM_RATE_LIMIT_SNAPSHOT_WRITE = '1';
    env.BILM_RATE_LIMIT_SNAPSHOT_WRITE_WINDOW_MS = '60000';
    const payload = {
      schema: 'bilm-backup-v1',
      meta: {
        updatedAtMs: 1713333333333,
        deviceId: 'device-rate'
      },
      localStorage: {}
    };
    const requestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer third-token',
        origin: ALLOWED_ORIGIN
      },
      body: JSON.stringify({ userId: THIRD_USER_ID, data: payload })
    };

    const first = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${THIRD_USER_ID}`, requestInit), env);
    expect(first.status).toBe(200);

    const second = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${THIRD_USER_ID}`, requestInit), env);
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBeTruthy();
    expect((await second.json()).code).toBe('private_data_rate_limited');
  });

  it('resets all saved account data for the authenticated user', async () => {
    d1.rows.set(USER_ID, {
      user_id: USER_ID,
      snapshot_json: JSON.stringify({ schema: 'bilm-backup-v1' }),
      updated_at_ms: 1710000000000,
      device_id: 'device-reset',
      schema: 'bilm-backup-v1',
      saved_at: new Date().toISOString()
    });
    d1.rows.set(OTHER_USER_ID, {
      user_id: OTHER_USER_ID,
      snapshot_json: JSON.stringify({ schema: 'bilm-backup-v1' }),
      updated_at_ms: 1710000000100,
      device_id: 'device-other',
      schema: 'bilm-backup-v1',
      saved_at: new Date().toISOString()
    });

    d1.syncRows.set(`${USER_ID}|favorites|movie:1`, {
      user_id: USER_ID,
      sector_key: 'favorites',
      item_key: 'movie:1',
      item_json: '{"id":1}',
      updated_at_ms: 1710000000000,
      deleted_at_ms: null,
      device_id: 'device-reset',
      op_id: 'op-reset',
      saved_at: new Date().toISOString()
    });
    d1.syncRows.set(`${OTHER_USER_ID}|favorites|movie:2`, {
      user_id: OTHER_USER_ID,
      sector_key: 'favorites',
      item_key: 'movie:2',
      item_json: '{"id":2}',
      updated_at_ms: 1710000000200,
      deleted_at_ms: null,
      device_id: 'device-other',
      op_id: 'op-other',
      saved_at: new Date().toISOString()
    });

    d1.listRows.set(`${USER_ID}|bilm-favorites|movie:1`, {
      user_id: USER_ID,
      list_key: 'bilm-favorites',
      item_key: 'movie:1',
      item_json: '{"id":1}',
      updated_at_ms: 1710000000000,
      deleted_at_ms: null,
      device_id: 'device-reset',
      saved_at: new Date().toISOString()
    });
    d1.listRows.set(`${OTHER_USER_ID}|bilm-favorites|movie:2`, {
      user_id: OTHER_USER_ID,
      list_key: 'bilm-favorites',
      item_key: 'movie:2',
      item_json: '{"id":2}',
      updated_at_ms: 1710000000200,
      deleted_at_ms: null,
      device_id: 'device-other',
      saved_at: new Date().toISOString()
    });

    d1.syncStateRows.set(USER_ID, {
      user_id: USER_ID,
      migrated_at_ms: 1710000000000,
      migration_source: 'firebase_snapshot',
      updated_at_ms: 1710000000000,
      saved_at: new Date().toISOString()
    });

    d1.accountCapabilityRows.set(USER_ID, {
      user_id: USER_ID,
      email: 'alice@example.com',
      chat_ready: 0,
      last_chat_seen_at_ms: null,
      updated_at_ms: 1710000000000
    });
    d1.accountLinkRows.set('link-reset', {
      id: 'link-reset',
      status: 'pending',
      requester_user_id: USER_ID,
      requester_email: 'alice@example.com',
      target_user_id: OTHER_USER_ID,
      target_email: 'bob@example.com',
      requester_share_scopes_json: '{"favorites":true}',
      target_share_scopes_json: '{}',
      requester_approved_at_ms: 1710000000000,
      target_approved_at_ms: null,
      created_at_ms: 1710000000000,
      updated_at_ms: 1710000000000,
      activated_at_ms: null,
      declined_at_ms: null,
      unlinked_at_ms: null
    });

    await kv.put(`user-${USER_ID}`, JSON.stringify({ schema: 'bilm-backup-v1', userId: USER_ID }));
    await kv.put(`user-${OTHER_USER_ID}`, JSON.stringify({ schema: 'bilm-backup-v1', userId: OTHER_USER_ID }));

    const response = await worker.fetch(new Request('https://data-api.watchbilm.org/account/reset', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token',
        origin: ALLOWED_ORIGIN
      },
      body: JSON.stringify({ userId: USER_ID })
    }), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.userId).toBe(USER_ID);
    expect(body.deleted.snapshots).toBe(1);
    expect(body.deleted.sectorSyncItems).toBe(1);
    expect(body.deleted.listSyncItems).toBe(1);
    expect(body.deleted.syncState).toBe(1);
    expect(body.deleted.accountLinks).toBe(1);
    expect(body.deleted.accountCapabilities).toBe(1);
    expect(body.deleted.kvSnapshots).toBe(1);

    expect(d1.rows.has(USER_ID)).toBe(false);
    expect(d1.rows.has(OTHER_USER_ID)).toBe(true);
    expect([...d1.syncRows.values()].every((row) => row.user_id !== USER_ID)).toBe(true);
    expect([...d1.syncRows.values()].some((row) => row.user_id === OTHER_USER_ID)).toBe(true);
    expect([...d1.listRows.values()].every((row) => row.user_id !== USER_ID)).toBe(true);
    expect([...d1.listRows.values()].some((row) => row.user_id === OTHER_USER_ID)).toBe(true);
    expect(d1.syncStateRows.has(USER_ID)).toBe(false);
    expect(d1.accountCapabilityRows.has(USER_ID)).toBe(false);
    expect(d1.accountLinkRows.has('link-reset')).toBe(false);
    expect(await kv.get(`user-${USER_ID}`)).toBeNull();
    expect(await kv.get(`user-${OTHER_USER_ID}`)).not.toBeNull();
  });

  it('rejects account reset when token subject does not match userId', async () => {
    const response = await worker.fetch(new Request('https://data-api.watchbilm.org/account/reset', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer other-token'
      },
      body: JSON.stringify({ userId: USER_ID })
    }), env);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('forbidden');
  });

  it('returns service health metadata', async () => {
    const response = await worker.fetch(new Request('https://data-api.watchbilm.org/health', {
      method: 'GET',
      headers: { origin: ALLOWED_ORIGIN }
    }), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe('data-api');
    expect(body.storage?.snapshotStorageReady).toBe(true);
    expect(Array.isArray(body.endpoints)).toBe(true);
    expect(body.endpoints.some((entry) => entry.id === 'cloud_export_save')).toBe(true);
    expect(body.endpoints.some((entry) => entry.id === 'account_reset')).toBe(true);
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

    const flyAllowedPreflight = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED_FLY_ORIGIN }
    }), env);
    expect(flyAllowedPreflight.status).toBe(204);
    expect(flyAllowedPreflight.headers.get('access-control-allow-origin')).toBe(ALLOWED_FLY_ORIGIN);

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

  it('does not expose media routes on data-api', async () => {
    const response = await worker.fetch(new Request('https://data-api.watchbilm.org/media/tmdb/movie/603', {
      method: 'GET'
    }), env);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe('route_not_found');
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

  it('allows valid retries after a non-retryable operation failure', async () => {
    const tooLongChat = 'x'.repeat(2105);
    const failedBatch = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/sectors/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        operations: [
          {
            sectorKey: 'chat_messages',
            itemKey: 'chat:oversize',
            updatedAtMs: 1721800000000,
            deleted: false,
            payload: { id: 'chat-oversize', text: tooLongChat, createdAtMs: 1721800000000 }
          },
          {
            sectorKey: 'watch_history',
            itemKey: 'movie:181',
            updatedAtMs: 1721800000100,
            deleted: false,
            payload: { key: 'movie-181', type: 'movie', id: 181, updatedAt: 1721800000100 }
          }
        ]
      })
    }), env);
    expect(failedBatch.status).toBe(413);

    const retryValidOnly = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/sectors/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        operations: [
          {
            sectorKey: 'watch_history',
            itemKey: 'movie:181',
            updatedAtMs: 1721800000100,
            deleted: false,
            payload: { key: 'movie-181', type: 'movie', id: 181, updatedAt: 1721800000100 }
          }
        ]
      })
    }), env);
    expect(retryValidOnly.status).toBe(200);

    const pull = await worker.fetch(new Request(`https://data-api.watchbilm.org/sync/sectors/pull?userId=${USER_ID}&since=0&sectors=watch_history`, {
      method: 'GET',
      headers: { authorization: 'Bearer valid-token' }
    }), env);
    expect(pull.status).toBe(200);
    const body = await pull.json();
    expect(body.operations.length).toBe(1);
    expect(body.operations[0].itemKey).toBe('movie:181');
  });

  it('clamps future updatedAtMs and still accepts newer normal-time updates', async () => {
    const baseNowMs = 1726000000000;
    vi.useFakeTimers();
    vi.setSystemTime(baseNowMs);
    try {
      const futurePush = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/sectors/push', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer valid-token'
        },
        body: JSON.stringify({
          userId: USER_ID,
          operations: [
            {
              sectorKey: 'watch_history',
              itemKey: 'movie:future',
              updatedAtMs: baseNowMs + (24 * 60 * 60 * 1000),
              deleted: false,
              payload: { key: 'movie-future', type: 'movie', id: 991, updatedAt: baseNowMs + (24 * 60 * 60 * 1000) }
            }
          ]
        })
      }), env);
      expect(futurePush.status).toBe(200);
      const futurePushBody = await futurePush.json();
      expect(futurePushBody.cursorMs).toBe(baseNowMs + SYNC_FUTURE_TIME_WINDOW_MS);

      vi.setSystemTime(baseNowMs + SYNC_FUTURE_TIME_WINDOW_MS + 60000);
      const normalPush = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/sectors/push', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer valid-token'
        },
        body: JSON.stringify({
          userId: USER_ID,
          operations: [
            {
              sectorKey: 'watch_history',
              itemKey: 'movie:future',
              updatedAtMs: Date.now(),
              deleted: false,
              payload: { key: 'movie-future', type: 'movie', id: 992, updatedAt: Date.now() }
            }
          ]
        })
      }), env);
      expect(normalPush.status).toBe(200);

      const pull = await worker.fetch(new Request(`https://data-api.watchbilm.org/sync/sectors/pull?userId=${USER_ID}&since=0&sectors=watch_history`, {
        method: 'GET',
        headers: { authorization: 'Bearer valid-token' }
      }), env);
      expect(pull.status).toBe(200);
      const pullBody = await pull.json();
      const updated = pullBody.operations.find((operation) => operation.itemKey === 'movie:future');
      expect(updated).toBeTruthy();
      expect(updated.updatedAtMs).toBe(Date.now());
      expect(updated.payload.id).toBe(992);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps future since cursors and preserves pull progression', async () => {
    const baseNowMs = 1726100000000;
    vi.useFakeTimers();
    vi.setSystemTime(baseNowMs);
    try {
      const firstPush = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/sectors/push', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer valid-token'
        },
        body: JSON.stringify({
          userId: USER_ID,
          operations: [
            {
              sectorKey: 'favorites',
              itemKey: 'movie:201',
              updatedAtMs: baseNowMs + 1000,
              deleted: false,
              payload: { key: 'movie-201', type: 'movie', id: 201, updatedAt: baseNowMs + 1000 }
            }
          ]
        })
      }), env);
      expect(firstPush.status).toBe(200);

      const futureSinceMs = baseNowMs + (12 * 60 * 60 * 1000);
      const clampedPull = await worker.fetch(new Request(
        `https://data-api.watchbilm.org/sync/sectors/pull?userId=${USER_ID}&since=${futureSinceMs}&sectors=favorites`,
        {
          method: 'GET',
          headers: { authorization: 'Bearer valid-token' }
        }
      ), env);
      expect(clampedPull.status).toBe(200);
      const clampedBody = await clampedPull.json();
      expect(clampedBody.operations.length).toBe(0);
      expect(clampedBody.cursorMs).toBe(baseNowMs + SYNC_FUTURE_TIME_WINDOW_MS);

      vi.setSystemTime(baseNowMs + SYNC_FUTURE_TIME_WINDOW_MS + 120000);
      const secondUpdatedAtMs = Date.now();
      const secondPush = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/sectors/push', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer valid-token'
        },
        body: JSON.stringify({
          userId: USER_ID,
          operations: [
            {
              sectorKey: 'favorites',
              itemKey: 'movie:202',
              updatedAtMs: secondUpdatedAtMs,
              deleted: false,
              payload: { key: 'movie-202', type: 'movie', id: 202, updatedAt: secondUpdatedAtMs }
            }
          ]
        })
      }), env);
      expect(secondPush.status).toBe(200);

      const progressionPull = await worker.fetch(new Request(
        `https://data-api.watchbilm.org/sync/sectors/pull?userId=${USER_ID}&since=${clampedBody.cursorMs}&sectors=favorites`,
        {
          method: 'GET',
          headers: { authorization: 'Bearer valid-token' }
        }
      ), env);
      expect(progressionPull.status).toBe(200);
      const progressionBody = await progressionPull.json();
      expect(progressionBody.operations.length).toBe(1);
      expect(progressionBody.operations[0].itemKey).toBe('movie:202');
      expect(progressionBody.operations[0].updatedAtMs).toBe(secondUpdatedAtMs);
    } finally {
      vi.useRealTimers();
    }
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

  it('keeps list tombstones when delete and upsert share the same timestamp', async () => {
    const deleteTie = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/lists/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        operations: [
          {
            listKey: 'bilm-favorites',
            itemKey: 'movie:77',
            updatedAtMs: 1722500000000,
            deleted: true
          }
        ]
      })
    }), env);
    expect(deleteTie.status).toBe(200);

    const staleUpsertSameTs = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/lists/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        operations: [
          {
            listKey: 'bilm-favorites',
            itemKey: 'movie:77',
            updatedAtMs: 1722500000000,
            deleted: false,
            payload: { key: 'movie-77', type: 'movie', id: 77, updatedAt: 1722500000000 }
          }
        ]
      })
    }), env);
    expect(staleUpsertSameTs.status).toBe(200);

    const pull = await worker.fetch(new Request(`https://data-api.watchbilm.org/sync/lists/pull?userId=${USER_ID}&since=0`, {
      method: 'GET',
      headers: { authorization: 'Bearer valid-token' }
    }), env);
    expect(pull.status).toBe(200);
    const body = await pull.json();
    const tiedOperation = body.operations.find((operation) => operation.itemKey === 'movie:77');
    expect(tiedOperation).toBeTruthy();
    expect(tiedOperation.deleted).toBe(true);
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

  it('allows temporary auth bypass when enabled in env', async () => {
    const bypassEnv = createEnv({ kv, d1, disableAuth: true });
    const response = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/sectors/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bilm-auth-bypass': 'test-auth-bypass-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        operations: [
          {
            sectorKey: 'watch_history',
            itemKey: 'movie:501',
            updatedAtMs: 1729000000000,
            deleted: false,
            payload: { key: 'movie-501', type: 'movie', id: 501, updatedAt: 1729000000000 }
          }
        ]
      })
    }), bypassEnv);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(1);
  });

  it('pushes and pulls sector sync operations with state metadata', async () => {
    const push = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/sectors/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        deviceId: 'device-alpha',
        operations: [
          {
            sectorKey: 'watch_history',
            itemKey: 'movie:44',
            updatedAtMs: 1723000000000,
            opId: 'op-1',
            deleted: false,
            payload: { key: 'movie-44', type: 'movie', id: 44, updatedAt: 1723000000000 }
          },
          {
            sectorKey: 'chat_messages',
            itemKey: 'chat:abc',
            updatedAtMs: 1723000000100,
            opId: 'op-2',
            deleted: false,
            payload: { id: 'abc', text: 'hi', author: 'test', createdAtMs: 1723000000100 }
          }
        ]
      })
    }), env);

    expect(push.status).toBe(200);
    const pushBody = await push.json();
    expect(pushBody.ok).toBe(true);
    expect(pushBody.processed).toBe(2);
    expect(pushBody.cursorMs).toBe(1723000000100);
    expect(push.headers.get('x-request-id')).toBeTruthy();

    const pull = await worker.fetch(new Request(`https://data-api.watchbilm.org/sync/sectors/pull?userId=${USER_ID}&since=0&sectors=chat_messages,watch_history`, {
      method: 'GET',
      headers: { authorization: 'Bearer valid-token' }
    }), env);

    expect(pull.status).toBe(200);
    const pullBody = await pull.json();
    expect(pullBody.ok).toBe(true);
    expect(pullBody.operations.length).toBe(2);
    expect(pullBody.operations[0].sectorKey).toBe('watch_history');
    expect(pullBody.operations[1].sectorKey).toBe('chat_messages');
    expect(pullBody.state.migratedAtMs).toBeNull();
  });

  it('keeps sector tombstones when delete and upsert share the same timestamp', async () => {
    const deleteTie = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/sectors/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        operations: [
          {
            sectorKey: 'chat_messages',
            itemKey: 'chat:tie-case',
            updatedAtMs: 1723500000000,
            opId: 'op-delete',
            deleted: true
          }
        ]
      })
    }), env);
    expect(deleteTie.status).toBe(200);

    const staleUpsertSameTs = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/sectors/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        operations: [
          {
            sectorKey: 'chat_messages',
            itemKey: 'chat:tie-case',
            updatedAtMs: 1723500000000,
            opId: 'op-upsert-z',
            deleted: false,
            payload: { id: 'tie-case', text: 'stale upsert', author: 'test', createdAtMs: 1723500000000 }
          }
        ]
      })
    }), env);
    expect(staleUpsertSameTs.status).toBe(200);

    const pull = await worker.fetch(new Request(`https://data-api.watchbilm.org/sync/sectors/pull?userId=${USER_ID}&since=0&sectors=chat_messages`, {
      method: 'GET',
      headers: { authorization: 'Bearer valid-token' }
    }), env);
    expect(pull.status).toBe(200);
    const body = await pull.json();
    const tiedOperation = body.operations.find((operation) => operation.itemKey === 'chat:tie-case');
    expect(tiedOperation).toBeTruthy();
    expect(tiedOperation.deleted).toBe(true);
  });

  it('bootstraps sectors once and skips on subsequent attempts', async () => {
    const first = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/sectors/bootstrap', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        migrationSource: 'firebase_snapshot',
        operations: [
          {
            sectorKey: 'favorites',
            itemKey: 'movie:90',
            updatedAtMs: 1724000000000,
            deleted: false,
            payload: { key: 'movie-90', type: 'movie', id: 90, updatedAt: 1724000000000 }
          }
        ]
      })
    }), env);

    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.ok).toBe(true);
    expect(firstBody.skipped).toBe(false);
    expect(firstBody.state.migratedAtMs).toBeTruthy();
    expect(firstBody.state.migrationSource).toBe('firebase_snapshot');

    const second = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/sectors/bootstrap', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        migrationSource: 'local_fallback',
        operations: []
      })
    }), env);

    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.ok).toBe(true);
    expect(secondBody.skipped).toBe(true);
    expect(secondBody.state.migrationSource).toBe('firebase_snapshot');
  });

  it('returns chat-specific validation errors with retry metadata', async () => {
    const payload = 'x'.repeat(2105);
    const response = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/sectors/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        operations: [
          {
            sectorKey: 'chat_messages',
            itemKey: 'chat:too-long',
            updatedAtMs: 1725000000000,
            deleted: false,
            payload: { id: 'too-long', text: payload, createdAtMs: 1725000000000 }
          }
        ]
      })
    }), env);

    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error).toBe('payload_too_large');
    expect(body.code).toBe('chat_message_too_large');
    expect(body.retryable).toBe(false);
    expect(body.requestId).toBeTruthy();
  });

  it('accepts settings/profile and progress sector operations', async () => {
    const response = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/sectors/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        operations: [
          {
            sectorKey: 'settings_profile',
            itemKey: 'theme_settings',
            updatedAtMs: 1725100000000,
            deleted: false,
            payload: {
              storageKey: 'bilm-theme-settings',
              value: '{"defaultServer":"embedmaster"}'
            }
          },
          {
            sectorKey: 'playback_notes',
            itemKey: 'playback_note',
            updatedAtMs: 1725100000100,
            deleted: false,
            payload: {
              storageKey: 'bilm-playback-note',
              value: '{"movie:42":"01:20"}'
            }
          }
        ]
      })
    }), env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(2);
  });

  it('enforces generic sector payload size limits', async () => {
    const hugeValue = 'x'.repeat(20050);
    const response = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/sectors/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        operations: [
          {
            sectorKey: 'settings_profile',
            itemKey: 'theme_settings',
            updatedAtMs: 1725200000000,
            deleted: false,
            payload: {
              storageKey: 'bilm-theme-settings',
              value: hugeValue
            }
          }
        ]
      })
    }), env);

    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.code).toBe('sector_payload_too_large');
    expect(body.requestId).toBeTruthy();
  });

  it('creates account links with non-chat scopes and watch later support', async () => {
    const registerTarget = await worker.fetch(new Request(`https://data-api.watchbilm.org/links?userId=${OTHER_USER_ID}`, {
      headers: { authorization: 'Bearer other-token' }
    }), env);
    expect(registerTarget.status).toBe(200);

    const response = await worker.fetch(new Request('https://data-api.watchbilm.org/links/request', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        targetEmail: 'Bob@Example.com',
        shareScopes: {
          favorites: true,
          watch_later: true,
          secretChat: true
        }
      })
    }), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.link.status).toBe('pending');
    expect(body.link.partner.email).toBe('bob@example.com');
    expect(body.link.me.shareScopes.favorites).toBe(true);
    expect(body.link.me.shareScopes.watchLater).toBe(true);
    expect(body.link.me.shareScopes.secretChat).toBeUndefined();
  });

  it('surfaces pending requests for equivalent gmail aliases', async () => {
    const registerTarget = await worker.fetch(new Request(`https://data-api.watchbilm.org/links?userId=${GMAIL_USER_ID}`, {
      headers: { authorization: 'Bearer gmail-token' }
    }), env);
    expect(registerTarget.status).toBe(200);

    const createResponse = await worker.fetch(new Request('https://data-api.watchbilm.org/links/request', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        targetEmail: 'worlds.forming+watch@googlemail.com',
        shareScopes: {
          favorites: true
        }
      })
    }), env);
    expect(createResponse.status).toBe(200);

    const listResponse = await worker.fetch(new Request(`https://data-api.watchbilm.org/links?userId=${GMAIL_USER_ID}`, {
      headers: { authorization: 'Bearer gmail-token' }
    }), env);
    expect(listResponse.status).toBe(200);
    const payload = await listResponse.json();
    expect(Array.isArray(payload.incomingRequests)).toBe(true);
    expect(payload.incomingRequests.length).toBe(1);
    expect(payload.incomingRequests[0].myRole).toBe('target');
    expect(payload.incomingRequests[0].canApprove).toBe(true);
  });

  it('rejects self links and blocks a second pending link', async () => {
    const selfLink = await worker.fetch(new Request('https://data-api.watchbilm.org/links/request', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        targetEmail: 'alice@example.com',
        shareScopes: { favorites: true }
      })
    }), env);
    expect(selfLink.status).toBe(400);
    expect((await selfLink.json()).code).toBe('self_link_forbidden');

    const registerBob = await worker.fetch(new Request(`https://data-api.watchbilm.org/links?userId=${OTHER_USER_ID}`, {
      headers: { authorization: 'Bearer other-token' }
    }), env);
    expect(registerBob.status).toBe(200);

    const first = await worker.fetch(new Request('https://data-api.watchbilm.org/links/request', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        targetEmail: 'bob@example.com',
        shareScopes: { favorites: true }
      })
    }), env);
    expect(first.status).toBe(200);

    const second = await worker.fetch(new Request('https://data-api.watchbilm.org/links/request', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        targetEmail: 'charlie@example.com',
        shareScopes: { watchHistory: true }
      })
    }), env);
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('requester_link_conflict');
  });

  it('allows account-link requests when target email is not yet indexed in capabilities', async () => {
    const response = await worker.fetch(new Request('https://data-api.watchbilm.org/links/request', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        targetEmail: 'missing-user@example.com',
        shareScopes: { favorites: true }
      })
    }), env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.accountFound).toBe(false);
    expect(body.link.status).toBe('pending');
    expect(body.link.partner.email).toBe('missing-user@example.com');
  });

  it('indexes capability from authenticated snapshot writes for account-link lookup', async () => {
    const saveResponse = await worker.fetch(new Request('https://data-api.watchbilm.org/', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer other-token'
      },
      body: JSON.stringify({
        userId: OTHER_USER_ID,
        data: {
          schema: 'bilm-backup-v1',
          meta: { updatedAtMs: 1727000000000 },
          localStorage: {}
        }
      })
    }), env);
    expect(saveResponse.status).toBe(200);

    const lookupResponse = await worker.fetch(new Request(`https://data-api.watchbilm.org/links/target-capabilities?userId=${USER_ID}&email=bob@example.com`, {
      headers: { authorization: 'Bearer valid-token' }
    }), env);
    expect(lookupResponse.status).toBe(200);
    const payload = await lookupResponse.json();
    expect(payload.ok).toBe(true);
    expect(payload.accountFound).toBe(true);
    expect(payload.canRequest).toBe(true);
  });

  it('approves links and shared-feed returns approved non-chat sectors with a signature', async () => {
    const registerTarget = await worker.fetch(new Request(`https://data-api.watchbilm.org/links?userId=${OTHER_USER_ID}`, {
      headers: { authorization: 'Bearer other-token' }
    }), env);
    expect(registerTarget.status).toBe(200);

    const createResponse = await worker.fetch(new Request('https://data-api.watchbilm.org/links/request', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        targetEmail: 'bob@example.com',
        shareScopes: {
          continueWatching: true,
          favorites: true,
          watchLater: true,
          secretChat: true
        }
      })
    }), env);
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json();
    const linkId = created.link.id;

    const approveResponse = await worker.fetch(new Request('https://data-api.watchbilm.org/links/respond', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer other-token'
      },
      body: JSON.stringify({
        userId: OTHER_USER_ID,
        linkId,
        action: 'approve',
        shareScopes: { continueWatching: true }
      })
    }), env);
    expect(approveResponse.status).toBe(200);
    const approved = await approveResponse.json();
    expect(approved.link.status).toBe('active');
    expect(approved.link.me.shareScopes.continueWatching).toBe(true);

    const pushResponse = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/sectors/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        operations: [
          {
            sectorKey: 'favorites',
            itemKey: 'movie:10',
            updatedAtMs: 1726000000000,
            deleted: false,
            payload: { key: 'tmdb:movie:10', title: 'Favorite Movie', updatedAt: 1726000000000 }
          },
          {
            sectorKey: 'watch_later',
            itemKey: 'movie:11',
            updatedAtMs: 1726000000100,
            deleted: false,
            payload: { key: 'tmdb:movie:11', title: 'Later Movie', updatedAt: 1726000000100 }
          },
          {
            sectorKey: 'tv_progress',
            itemKey: 'bilm-tv-progress-tmdb-101',
            updatedAtMs: 1726000000150,
            deleted: false,
            payload: {
              storageKey: 'bilm-tv-progress-tmdb-101',
              value: JSON.stringify({ season: 2, episode: 5 })
            }
          },
          {
            sectorKey: 'chat_messages',
            itemKey: 'chat:1',
            updatedAtMs: 1726000000200,
            deleted: false,
            payload: { id: 'chat-1', text: 'not shared', createdAtMs: 1726000000200 }
          }
        ]
      })
    }), env);
    expect(pushResponse.status).toBe(200);

    const feedResponse = await worker.fetch(new Request(`https://data-api.watchbilm.org/links/shared-feed?userId=${OTHER_USER_ID}&since=0`, {
      headers: { authorization: 'Bearer other-token' }
    }), env);
    expect(feedResponse.status).toBe(200);
    const feed = await feedResponse.json();
    expect(feed.linkSignature).toContain(linkId);
    const sharedSectors = feed.operations.map((operation) => operation.sectorKey);
    expect(sharedSectors).toEqual(expect.arrayContaining(['favorites', 'watch_later', 'tv_progress']));
    expect(sharedSectors).toHaveLength(3);
    expect(feed.operations.some((operation) => operation.sectorKey === 'chat_messages')).toBe(false);
  });

  it('paginates shared-feed safely when many records share the same timestamp', async () => {
    const registerTarget = await worker.fetch(new Request(`https://data-api.watchbilm.org/links?userId=${OTHER_USER_ID}`, {
      headers: { authorization: 'Bearer other-token' }
    }), env);
    expect(registerTarget.status).toBe(200);

    const createResponse = await worker.fetch(new Request('https://data-api.watchbilm.org/links/request', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        targetEmail: 'bob@example.com',
        shareScopes: { favorites: true }
      })
    }), env);
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json();
    const linkId = created.link.id;

    const approveResponse = await worker.fetch(new Request('https://data-api.watchbilm.org/links/respond', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer other-token'
      },
      body: JSON.stringify({
        userId: OTHER_USER_ID,
        linkId,
        action: 'approve',
        shareScopes: { favorites: true }
      })
    }), env);
    expect(approveResponse.status).toBe(200);

    const sharedTimestamp = 1727000000000;
    const operations = Array.from({ length: 130 }, (_, index) => {
      const itemNumber = index + 1;
      return {
        sectorKey: 'favorites',
        itemKey: `movie:${itemNumber}`,
        opId: `op-${String(itemNumber).padStart(4, '0')}`,
        updatedAtMs: sharedTimestamp,
        deleted: false,
        payload: {
          key: `tmdb:movie:${itemNumber}`,
          title: `Favorite ${itemNumber}`,
          updatedAt: sharedTimestamp
        }
      };
    });

    const pushResponse = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/sectors/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        operations
      })
    }), env);
    expect(pushResponse.status).toBe(200);

    const receivedItemKeys = [];
    let cursorUpdatedAtMs = 0;
    let cursorOpId = '';
    let cursorSectorKey = '';
    let cursorItemKey = '';
    let hasMore = true;
    let safetyCounter = 0;

    while (hasMore && safetyCounter < 20) {
      safetyCounter += 1;
      const params = new URLSearchParams({
        userId: OTHER_USER_ID,
        since: '0',
        limit: '25'
      });
      if (cursorUpdatedAtMs > 0 || cursorOpId || cursorSectorKey || cursorItemKey) {
        params.set('cursorUpdatedAtMs', String(cursorUpdatedAtMs));
        params.set('cursorOpId', cursorOpId);
        params.set('cursorSectorKey', cursorSectorKey);
        params.set('cursorItemKey', cursorItemKey);
      }

      const response = await worker.fetch(new Request(`https://data-api.watchbilm.org/links/shared-feed?${params.toString()}`, {
        headers: { authorization: 'Bearer other-token' }
      }), env);
      expect(response.status).toBe(200);
      const body = await response.json();

      expect(Array.isArray(body.operations)).toBe(true);
      body.operations.forEach((operation) => {
        receivedItemKeys.push(operation.itemKey);
      });

      cursorUpdatedAtMs = Number(body.cursorUpdatedAtMs || body.cursorMs || 0) || 0;
      cursorOpId = String(body.cursorOpId || '');
      cursorSectorKey = String(body.cursorSectorKey || '');
      cursorItemKey = String(body.cursorItemKey || '');
      hasMore = body.hasMore === true;
    }

    expect(safetyCounter).toBeLessThan(20);
    expect(receivedItemKeys.length).toBe(130);
    expect(new Set(receivedItemKeys).size).toBe(130);
  });

  it('returns target capability availability for known and unknown accounts', async () => {
    const registerTarget = await worker.fetch(new Request(`https://data-api.watchbilm.org/links?userId=${OTHER_USER_ID}`, {
      headers: { authorization: 'Bearer other-token' }
    }), env);
    expect(registerTarget.status).toBe(200);

    const response = await worker.fetch(new Request(`https://data-api.watchbilm.org/links/target-capabilities?userId=${USER_ID}&email=bob@example.com`, {
      headers: { authorization: 'Bearer valid-token' }
    }), env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.targetEmail).toBe('bob@example.com');
    expect(body.accountFound).toBe(true);
    expect(body.canRequest).toBe(true);
    expect(body.chatEligible).toBeUndefined();

    const missingResponse = await worker.fetch(new Request(`https://data-api.watchbilm.org/links/target-capabilities?userId=${USER_ID}&email=nobody@example.com`, {
      headers: { authorization: 'Bearer valid-token' }
    }), env);
    expect(missingResponse.status).toBe(200);
    const missingBody = await missingResponse.json();
    expect(missingBody.accountFound).toBe(false);
    expect(missingBody.canRequest).toBe(true);
  });

  it('rate limits account-link endpoints per user', async () => {
    env.ACCOUNT_LINK_RATE_LIMIT_READ = '1';
    env.ACCOUNT_LINK_RATE_LIMIT_READ_WINDOW_MS = '60000';

    const first = await worker.fetch(new Request(`https://data-api.watchbilm.org/links?userId=${THIRD_USER_ID}`, {
      headers: { authorization: 'Bearer third-token' }
    }), env);
    expect(first.status).toBe(200);

    const second = await worker.fetch(new Request(`https://data-api.watchbilm.org/links?userId=${THIRD_USER_ID}`, {
      headers: { authorization: 'Bearer third-token' }
    }), env);
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBeTruthy();
    expect((await second.json()).code).toBe('account_link_rate_limited');
  });

  it('mirrors snapshot saves to supabase canonical profile and user-data tables', async () => {
    enableSupabasePrimary(env);
    env.SUPABASE_MIRROR_ENABLED = 'true';
    env.SUPABASE_MIRROR_TABLE = 'cloudflare_mirror_events';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 201 }));
    const waiters = [];

    const payload = {
      schema: 'bilm-backup-v1',
      meta: {
        updatedAtMs: 1710000000000,
        deviceId: 'device-canonical'
      },
      localStorage: {
        'bilm-shared-chat': '[]'
      }
    };
    const response = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token',
        origin: ALLOWED_ORIGIN
      },
      body: JSON.stringify({ userId: USER_ID, data: payload })
    }), env, {
      waitUntil(promise) {
        waiters.push(promise);
      }
    });

    expect(response.status).toBe(200);
    await Promise.allSettled(waiters);

    const calledUrls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(calledUrls.some((url) => url.includes('/rest/v1/cloudflare_mirror_events'))).toBe(true);
    expect(calledUrls.some((url) => url.includes('/rest/v1/bilm_profiles'))).toBe(true);
    expect(calledUrls.some((url) => url.includes('/rest/v1/bilm_user_data'))).toBe(true);

    const canonicalWriteCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/rest/v1/bilm_user_data'));
    expect(canonicalWriteCall).toBeTruthy();
    const canonicalBody = JSON.parse(String(canonicalWriteCall[1]?.body || '[]'));
    expect(Array.isArray(canonicalBody)).toBe(true);
    expect(canonicalBody[0]?.user_id).toBe(USER_ID);
    expect(canonicalBody[0]?.data_scope).toBe('snapshot');
    expect(canonicalBody[0]?.data_group).toBe('snapshot');
    expect(canonicalBody[0]?.data_key).toBe('snapshot');
  });

  it('falls back to Cloudflare snapshot storage when Supabase primary writes fail', async () => {
    enableSupabasePrimary(env);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('supabase unavailable', { status: 503 }));

    const payload = {
      schema: 'bilm-backup-v1',
      meta: {
        updatedAtMs: 1710000000000,
        deviceId: 'device-fallback'
      },
      localStorage: {
        'bilm-favorites': '[]'
      }
    };
    const response = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({ userId: USER_ID, data: payload })
    }), env);

    expect(response.status).toBe(200);
    expect(d1.rows.has(USER_ID)).toBe(true);
    expect(await kv.get(`user-${USER_ID}`)).toBe(JSON.stringify(payload));
  });

  it('falls back to Cloudflare snapshot storage when Supabase primary reads fail', async () => {
    enableSupabasePrimary(env);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('supabase unavailable', { status: 503 }));
    const payload = {
      schema: 'bilm-backup-v1',
      meta: {
        updatedAtMs: 1711111111111,
        deviceId: 'd1-fallback'
      }
    };
    d1.rows.set(USER_ID, {
      user_id: USER_ID,
      snapshot_json: JSON.stringify(payload),
      updated_at_ms: 1711111111111,
      device_id: 'd1-fallback',
      schema: 'bilm-backup-v1',
      saved_at: new Date().toISOString()
    });

    const response = await worker.fetch(new Request(`https://data-api.watchbilm.org/?userId=${USER_ID}`, {
      headers: { authorization: 'Bearer valid-token' }
    }), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
  });

  it('uses D1 as list sync backup when Supabase primary is unavailable', async () => {
    enableSupabasePrimary(env);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('supabase unavailable', { status: 503 }));

    const pushResponse = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/lists/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        operations: [{
          listKey: 'bilm-favorites',
          itemKey: 'movie:77',
          updatedAtMs: 1722000000000,
          deleted: false,
          payload: { key: 'movie-77', type: 'movie', id: 77, updatedAt: 1722000000000 }
        }]
      })
    }), env);

    expect(pushResponse.status).toBe(200);
    expect(d1.listRows.has(`${USER_ID}|bilm-favorites|movie:77`)).toBe(true);

    const pullResponse = await worker.fetch(new Request(`https://data-api.watchbilm.org/sync/lists/pull?userId=${USER_ID}&since=0`, {
      headers: { authorization: 'Bearer valid-token' }
    }), env);
    expect(pullResponse.status).toBe(200);
    const pullBody = await pullResponse.json();
    expect(pullBody.operations).toHaveLength(1);
    expect(pullBody.operations[0]).toMatchObject({
      listKey: 'bilm-favorites',
      itemKey: 'movie:77',
      deleted: false
    });
  });

  it('uses D1 as sector sync backup when Supabase primary is unavailable', async () => {
    enableSupabasePrimary(env);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('supabase unavailable', { status: 503 }));

    const pushResponse = await worker.fetch(new Request('https://data-api.watchbilm.org/sync/sectors/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token'
      },
      body: JSON.stringify({
        userId: USER_ID,
        operations: [{
          sectorKey: 'watch_history',
          itemKey: 'movie:88',
          updatedAtMs: 1722000000100,
          opId: 'op-sector-fallback',
          deleted: false,
          payload: { key: 'movie-88', type: 'movie', id: 88, updatedAt: 1722000000100 }
        }]
      })
    }), env);

    expect(pushResponse.status).toBe(200);
    expect(d1.syncRows.has(`${USER_ID}|watch_history|movie:88`)).toBe(true);

    const pullResponse = await worker.fetch(new Request(`https://data-api.watchbilm.org/sync/sectors/pull?userId=${USER_ID}&since=0&sectors=watch_history`, {
      headers: { authorization: 'Bearer valid-token' }
    }), env);
    expect(pullResponse.status).toBe(200);
    const pullBody = await pullResponse.json();
    expect(pullBody.operations).toHaveLength(1);
    expect(pullBody.operations[0]).toMatchObject({
      sectorKey: 'watch_history',
      itemKey: 'movie:88',
      opId: 'op-sector-fallback',
      deleted: false
    });
  });

  it('purges deleted supabase canonical rows on scheduled run', async () => {
    env.SUPABASE_PROJECT_URL = 'https://example.supabase.co';
    env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    env.SUPABASE_CANONICAL_ENABLED = 'true';
    env.SUPABASE_CANONICAL_USER_DATA_TABLE = 'bilm_user_data';
    env.SUPABASE_CANONICAL_DELETED_RETENTION_DAYS = '7';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));

    await worker.scheduled({}, env, {});

    const deleteCall = fetchSpy.mock.calls.find(([, init]) => String(init?.method || '').toUpperCase() === 'DELETE');
    expect(deleteCall).toBeTruthy();
    const deleteUrl = String(deleteCall[0] || '');
    expect(deleteUrl).toContain('/rest/v1/bilm_user_data');
    expect(deleteUrl).toContain('deleted_at_ms=not.is.null');
    expect(deleteUrl).toContain('deleted_at_ms=lt.');
  });

  it('purges expired tombstones on scheduled run', async () => {
    d1.syncRows.set(`${USER_ID}|watch_history|movie:1`, {
      user_id: USER_ID,
      sector_key: 'watch_history',
      item_key: 'movie:1',
      item_json: null,
      updated_at_ms: 1700000000000,
      deleted_at_ms: 1700000000000,
      device_id: 'device-a',
      op_id: 'op-a',
      saved_at: new Date().toISOString()
    });
    d1.listRows.set(`${USER_ID}|bilm-watch-history|movie:2`, {
      user_id: USER_ID,
      list_key: 'bilm-watch-history',
      item_key: 'movie:2',
      item_json: null,
      updated_at_ms: 1700000000000,
      deleted_at_ms: 1700000000000,
      device_id: 'device-a',
      saved_at: new Date().toISOString()
    });
    expect(d1.syncRows.size).toBe(1);
    expect(d1.listRows.size).toBe(1);

    await worker.scheduled({}, env, {});

    expect(d1.syncRows.size).toBe(0);
    expect(d1.listRows.size).toBe(0);
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

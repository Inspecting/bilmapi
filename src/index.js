import { createRemoteJWKSet, jwtVerify } from 'jose';

const DEFAULT_PROJECT_ID = 'bilm-7bfe1';
const FIREBASE_ISSUER_BASE = 'https://securetoken.google.com';
const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
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

async function handleImportRequest({ request, env, corsOrigin }) {
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
      const kvKey = `user-${userId}`;
      writes.push(env.BILM_DATA.put(kvKey, JSON.stringify(docData || {}), {
        metadata: getSnapshotMetadata(docData)
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
  requireAdminToken({ request, corsOrigin, env });
  const data = await parseJsonBody(request, corsOrigin);
  const writes = [];
  let count = 0;

  for (const [docId, docData] of Object.entries(data || {})) {
    const userId = normalizeUserId(docId);
    if (!isValidUserId(userId)) continue;
    const kvKey = `user-${userId}`;
    writes.push(env.BILM_DATA.put(kvKey, JSON.stringify(docData || {}), {
      metadata: getSnapshotMetadata(docData)
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

async function handleGetSnapshot({ request, env, corsOrigin, verifyIdToken }) {
  const url = new URL(request.url);
  const userId = normalizeUserId(url.searchParams.get('userId'));
  if (!isValidUserId(userId)) {
    return jsonResponse(400, { error: 'invalid_user_id', message: 'Invalid or missing userId.' }, corsOrigin);
  }

  await requireSnapshotAuth({ request, corsOrigin, env, verifyIdToken, userId });

  const kvKey = `user-${userId}`;
  const wantsMeta = url.searchParams.get('meta') === 'true';

  if (wantsMeta) {
    const { value, metadata } = await env.BILM_DATA.getWithMetadata(kvKey, 'text');
    const updatedAtMs = Number(metadata?.updatedAtMs || 0) || null;
    return jsonResponse(200, {
      exists: value !== null,
      updatedAtMs,
      deviceId: String(metadata?.deviceId || '').trim() || null,
      schema: String(metadata?.schema || '').trim() || null
    }, corsOrigin);
  }

  const value = await env.BILM_DATA.get(kvKey);
  if (value === null) {
    return jsonResponse(404, { error: 'not_found', message: 'No snapshot found for this user.' }, corsOrigin);
  }

  return textResponse(200, value, corsOrigin);
}

async function handleSaveSnapshot({ request, env, corsOrigin, verifyIdToken }) {
  const body = await parseJsonBody(request, corsOrigin);
  const userId = normalizeUserId(body?.userId);
  if (!isValidUserId(userId)) {
    return jsonResponse(400, { error: 'invalid_user_id', message: 'Invalid or missing userId.' }, corsOrigin);
  }

  await requireSnapshotAuth({ request, corsOrigin, env, verifyIdToken, userId });

  if (typeof body?.data === 'undefined') {
    return jsonResponse(400, { error: 'missing_data', message: 'Snapshot data is required.' }, corsOrigin);
  }

  const kvKey = `user-${userId}`;
  const payload = body.data;
  await env.BILM_DATA.put(kvKey, JSON.stringify(payload), {
    metadata: getSnapshotMetadata(payload)
  });

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

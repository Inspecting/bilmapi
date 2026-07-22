const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEY_PREFIX = 'watch-party-v1:';
const ALLOWED_ORIGINS = new Set(['https://watchbilm.org', 'https://www.watchbilm.org', 'https://bilm.fly.dev']);

function numberSetting(value, fallback, min, max) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function config(env) {
  return {
    maxSize: numberSetting(env?.WATCH_PARTY_MAX_SIZE, 5, 2, 50),
    ttlMs: numberSetting(env?.WATCH_PARTY_TTL_MS, 21_600_000, 60_000, 604_800_000),
    graceMs: numberSetting(env?.WATCH_PARTY_RECONNECT_GRACE_MS, 45_000, 10_000, 600_000)
  };
}

function cors(request) {
  const origin = String(request.headers.get('origin') || '');
  if (!ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, accept',
    'access-control-max-age': '86400',
    vary: 'Origin'
  };
}

function response(status, payload, request, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...cors(request),
      ...headers
    }
  });
}

async function bodyJson(request) {
  if (!String(request.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
    throw Object.assign(new Error('Content-Type must be application/json.'), { status: 415 });
  }
  const text = await request.text();
  if (text.length > 32 * 1024) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  try {
    const result = text ? JSON.parse(text) : {};
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Object required');
    return result;
  } catch {
    throw Object.assign(new Error('Invalid JSON request.'), { status: 400 });
  }
}

function token(length = 18) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let binary = '';
  bytes.forEach((value) => { binary += String.fromCharCode(value); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function partyCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => CODE_CHARS[value % CODE_CHARS.length]).join('');
}

function cleanCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function cleanName(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ').slice(0, 32) || 'Guest';
}

function cleanMedia(value) {
  const media = value && typeof value === 'object' ? value : {};
  const type = String(media.type || '').toLowerCase();
  const id = String(media.id || '').trim().slice(0, 64);
  const rawPath = String(media.path || '').trim();
  if (!['movie', 'tv'].includes(type) || !/^[a-z0-9_-]{1,64}$/i.test(id)) return null;
  if (!rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('\\')) return null;
  try {
    const url = new URL(rawPath, 'https://watchbilm.org');
    if (url.origin !== 'https://watchbilm.org') return null;
    return {
      type,
      id,
      season: Math.max(0, Math.floor(Number(media.season) || 0)),
      episode: Math.max(0, Math.floor(Number(media.episode) || 0)),
      path: `${url.pathname}${url.search}`
    };
  } catch {
    return null;
  }
}

const keyFor = (code) => `${KEY_PREFIX}${code}`;

async function load(kv, code) {
  const raw = await kv.get(keyFor(code));
  if (!raw) return null;
  try {
    const party = JSON.parse(raw);
    if (!party || Number(party.expiresAt || 0) <= Date.now()) {
      await kv.delete(keyFor(code));
      return null;
    }
    party.participants = Array.isArray(party.participants)
      ? party.participants.map((person) => ({ ...person, canControl: Boolean(person?.canControl) }))
      : [];
    return party;
  } catch {
    await kv.delete(keyFor(code));
    return null;
  }
}

async function save(kv, party) {
  const seconds = Math.max(60, Math.ceil((Number(party.expiresAt || 0) - Date.now()) / 1000));
  await kv.put(keyFor(party.code), JSON.stringify(party), { expirationTtl: seconds });
}

function participantFor(party, id, participantToken) {
  return party.participants.find((person) => person.id === String(id || '') && person.token === String(participantToken || '')) || null;
}

function prune(party, graceMs) {
  const now = Date.now();
  party.participants = party.participants.filter((person) => now - Number(person.lastSeen || 0) < graceMs);
  if (!party.participants.length) return false;
  if (!party.participants.some((person) => person.id === party.hostId)) {
    party.participants.sort((a, b) => Number(a.joinedAt || 0) - Number(b.joinedAt || 0));
    party.hostId = party.participants[0].id;
  }
  return true;
}

function publicParty(party, participantId, graceMs) {
  const now = Date.now();
  const playback = { ...party.playback };
  if (playback.playing) playback.currentTime = Math.max(0, Number(playback.currentTime || 0) + (now - Number(playback.updatedAt || now)) / 1000);
  const currentParticipant = party.participants.find((person) => person.id === participantId);
  return {
    code: party.code,
    media: party.media,
    maxParticipants: party.maxParticipants,
    availableSlots: Math.max(0, party.maxParticipants - party.participants.length),
    participantId,
    participants: party.participants.map((person) => ({
      id: person.id,
      name: person.name,
      isHost: person.id === party.hostId,
      canControl: person.id === party.hostId || Boolean(person.canControl),
      isConnected: now - Number(person.lastSeen || 0) < Math.min(10_000, graceMs)
    })),
    hostId: party.hostId,
    canControl: participantId === party.hostId || Boolean(currentParticipant?.canControl),
    state: playback,
    createdAt: party.createdAt,
    expiresAt: party.expiresAt
  };
}

async function create({ request, env, kv }) {
  const body = await bodyJson(request);
  const media = cleanMedia(body.media);
  if (!media) return response(400, { error: 'A valid movie or TV watch-page identity is required.' }, request);
  const limits = config(env);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = partyCode();
    if (await kv.get(keyFor(code))) continue;
    const participantId = token(12);
    const participantToken = token(24);
    const now = Date.now();
    const party = {
      code,
      media,
      maxParticipants: Math.max(2, Math.min(limits.maxSize, Math.floor(Number(body.maxParticipants) || limits.maxSize))),
      hostId: participantId,
      participants: [{ id: participantId, token: participantToken, name: cleanName(body.name || 'Host'), canControl: true, joinedAt: now, lastSeen: now }],
      playback: { playing: false, currentTime: Math.max(0, Number(body.currentTime) || 0), duration: 0, event: 'created', server: String(body.server || '').slice(0, 32), revision: 1, updatedBy: participantId, updatedAt: now },
      createdAt: now,
      expiresAt: now + limits.ttlMs
    };
    await save(kv, party);
    return response(201, { party: publicParty(party, participantId, limits.graceMs), participantToken, testingLimit: limits.maxSize }, request);
  }
  return response(503, { error: 'Unable to allocate a party code. Please try again.' }, request);
}

async function mutate({ request, env, kv, code, action }) {
  const limits = config(env);
  const party = await load(kv, code);
  if (!party) return response(404, { error: 'Party not found or expired.' }, request);
  if (!prune(party, limits.graceMs)) {
    await kv.delete(keyFor(code));
    return response(404, { error: 'Party not found or expired.' }, request);
  }
  const body = await bodyJson(request);

  if (action === 'join') {
    const returning = participantFor(party, body.participantId, body.participantToken);
    if (returning) {
      returning.name = cleanName(body.name || returning.name);
      returning.lastSeen = Date.now();
      await save(kv, party);
      return response(200, { party: publicParty(party, returning.id, limits.graceMs), participantToken: returning.token, reconnected: true }, request);
    }
    if (party.participants.length >= party.maxParticipants) return response(409, { error: 'This party is full.' }, request);
    const participantId = token(12);
    const participantToken = token(24);
    const now = Date.now();
    party.participants.push({ id: participantId, token: participantToken, name: cleanName(body.name), canControl: false, joinedAt: now, lastSeen: now });
    await save(kv, party);
    return response(200, { party: publicParty(party, participantId, limits.graceMs), participantToken }, request);
  }

  const participant = participantFor(party, body.participantId, body.participantToken);
  if (!participant) return response(401, { error: 'Invalid party participant credentials.' }, request);
  participant.lastSeen = Date.now();

  if (action === 'heartbeat') {
    await save(kv, party);
    return response(200, { party: publicParty(party, participant.id, limits.graceMs) }, request);
  }
  if (action === 'leave') {
    party.participants = party.participants.filter((person) => person.id !== participant.id);
    if (!party.participants.length) {
      await kv.delete(keyFor(code));
      return response(200, { ok: true }, request);
    }
    if (party.hostId === participant.id) {
      party.participants.sort((a, b) => Number(a.joinedAt || 0) - Number(b.joinedAt || 0));
      party.hostId = party.participants[0].id;
    }
    await save(kv, party);
    return response(200, { ok: true }, request);
  }
  if (action === 'permissions') {
    if (party.hostId !== participant.id) return response(403, { error: 'Only the host can change playback permissions.' }, request);
    const target = party.participants.find((person) => person.id === String(body.targetParticipantId || ''));
    if (!target || target.id === party.hostId) return response(400, { error: 'Choose a current guest participant.' }, request);
    target.canControl = Boolean(body.canControl);
    await save(kv, party);
    return response(200, { party: publicParty(party, participant.id, limits.graceMs) }, request);
  }
  if (action === 'state') {
    if (party.hostId !== participant.id && !participant.canControl) return response(403, { error: 'The host has not enabled playback control for you.' }, request);
    const playback = body.playback && typeof body.playback === 'object' ? body.playback : {};
    party.playback = {
      playing: Boolean(playback.playing),
      currentTime: Math.max(0, Math.min(86400, Number(playback.currentTime) || 0)),
      duration: Math.max(0, Math.min(86400, Number(playback.duration) || 0)),
      event: String(playback.event || 'timeupdate').slice(0, 24),
      server: String(playback.server || '').slice(0, 32),
      revision: Number(party.playback?.revision || 0) + 1,
      updatedBy: participant.id,
      updatedAt: Date.now()
    };
    await save(kv, party);
    return response(200, { ok: true, state: party.playback }, request);
  }
  return response(404, { error: 'Unknown party action.' }, request);
}

export async function handleWatchPartyRequest({ request, env }) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
  const kv = env?.BILM_DATA;
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
    return response(503, { error: 'Watch Party storage is temporarily unavailable.' }, request);
  }
  try {
    if (request.method === 'POST' && url.pathname === '/watch-parties') return await create({ request, env, kv });
    const match = url.pathname.match(/^\/watch-parties\/([A-Za-z0-9]{4,12})\/(join|state|permissions|heartbeat|leave)$/);
    if (request.method === 'POST' && match) return await mutate({ request, env, kv, code: cleanCode(match[1]), action: match[2] });
    return response(405, { error: 'Method not allowed.' }, request, { allow: 'POST, OPTIONS' });
  } catch (error) {
    return response(Number(error?.status || 400), { error: error?.message || 'Invalid party request.' }, request);
  }
}

export const DEFAULT_STATE = {
  theme: 'light',
  motion: true,
  remind: true,
  advance: 5,
  template: [],
  days: {},
  demo: false,
  reviews: {},
  milestones: {},
  celebrated: {},
  pendingCelebration: {},
  pomo: {
    preset: 25,
    auto: false,
    sound: true,
    sessions: {},
    phase: 'focus',
    remain: 1500,
    running: false,
    endAt: null,
    round: 0,
    guard: false,
    taskId: null,
    taskTitle: '',
    sessionStartAt: null
  }
};

const MAX_EVENT_ID = 96;
const MAX_DEVICE_ID = 128;
const MAX_OPS = 200;
const MAX_PATH = 32;
const MAX_SEGMENT = 160;
const MAX_STATE_BYTES = 1024 * 1024;
const SAFE_SEGMENT = /^[^.[\]\\/]{1,160}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function validateEmail(value) {
  const email = normalizeEmail(value);
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function validPath(path) {
  return Array.isArray(path)
    && path.length <= MAX_PATH
    && path.every(segment => typeof segment === 'string'
      && segment.length > 0
      && segment.length <= MAX_SEGMENT
      && SAFE_SEGMENT.test(segment)
      && !FORBIDDEN_KEYS.has(segment));
}

function validOp(op) {
  return op && (op.op === 'set' || op.op === 'remove' || op.op === 'replace')
    && validPath(op.path)
    && (op.op !== 'set' || op.value !== undefined)
    && (op.op !== 'replace' || op.value !== undefined);
}

export function validateEvent(event) {
  if (!event || typeof event !== 'object') return { ok: false, error: 'event_invalid' };
  if (typeof event.eventId !== 'string' || event.eventId.length < 1 || event.eventId.length > MAX_EVENT_ID) {
    return { ok: false, error: 'event_id_invalid' };
  }
  if (typeof event.deviceId !== 'string' || event.deviceId.length < 1 || event.deviceId.length > MAX_DEVICE_ID) {
    return { ok: false, error: 'device_id_invalid' };
  }
  if (!Number.isSafeInteger(event.baseSeq) || event.baseSeq < 0) return { ok: false, error: 'base_seq_invalid' };
  if (!Array.isArray(event.ops) || event.ops.length > MAX_OPS || !event.ops.every(validOp)) {
    return { ok: false, error: 'ops_invalid' };
  }
  if (event.clientAt !== undefined && (!Number.isSafeInteger(event.clientAt) || event.clientAt < 0)) {
    return { ok: false, error: 'client_time_invalid' };
  }
  return { ok: true };
}

function getParent(root, path, create) {
  let current = root;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current) && !/^\d+$/.test(segment)) return null;
    if (!(segment in current)) {
      if (!create) return null;
      current[segment] = {};
    }
    current = current[segment];
  }
  return current;
}

function setAt(root, path, value) {
  if (!path.length) return clone(value);
  const parent = getParent(root, path.slice(0, -1), true);
  if (!parent) return root;
  parent[path[path.length - 1]] = clone(value);
  return root;
}

function removeAt(root, path) {
  if (!path.length) return {};
  const parent = getParent(root, path.slice(0, -1), false);
  if (!parent) return root;
  const key = path[path.length - 1];
  if (Array.isArray(parent)) parent.splice(Number(key), 1);
  else delete parent[key];
  return root;
}

export function applyOps(state, ops) {
  let next = clone(state) || {};
  for (const op of ops || []) {
    if (op.op === 'replace' && op.path.length === 0) next = clone(op.value) || {};
    else if (op.op === 'set') next = setAt(next, op.path, op.value);
    else if (op.op === 'remove') next = removeAt(next, op.path);
  }
  return next;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

export function diffState(before, after, path = []) {
  if (Object.is(before, after)) return [];
  if (Array.isArray(before) || Array.isArray(after) || !isObject(before) || !isObject(after)) {
    return [{ op: 'set', path, value: clone(after) }];
  }
  const ops = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    const childPath = [...path, key];
    if (!(key in after)) ops.push({ op: 'remove', path: childPath });
    else if (!(key in before)) ops.push({ op: 'set', path: childPath, value: clone(after[key]) });
    else ops.push(...diffState(before[key], after[key], childPath));
  }
  return ops;
}

export function validateStateSize(state) {
  const bytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  return bytes <= MAX_STATE_BYTES;
}

export function compactState(state) {
  const next = clone(state) || {};
  if (!isObject(next.days)) next.days = {};
  if (!isObject(next.reviews)) next.reviews = {};
  if (!isObject(next.pomo)) next.pomo = {};
  return next;
}

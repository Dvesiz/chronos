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

const AVATAR_DATA_MAX = 700000;
export function validateAvatarData(value) {
  if (value === '' || value === null || value === undefined) return true;
  return typeof value === 'string'
    && value.length <= AVATAR_DATA_MAX
    && /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value);
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

/**
 * 数组元素的身份键。
 *
 * 两台设备改同一天的 tasks 时，客户端 diff 出来的是「整条 tasks 数组的 set」。
 * 如果服务端按整块覆盖，后到的会抹掉先到的另一项改动（LWW 太粗）。
 * 这里给已知集合挑一个稳定 id 键，用于按元素合并。
 */
const ARRAY_ID_KEYS = ['tasks', 'partialFocus'];

/**
 * 按元素 id 合并两个数组。
 *
 * 语义边界（重要）：
 *  - 只有当「incoming 里的 id 在 base 中都不存在」时，才保留 base 的元素。
 *    也就是：A 改了 task-1、B 改了 task-2，两次提交都能留下。
 *  - 同一个 id 两边都有时，仍然用 incoming 覆盖 —— 因为任务对象没有逐元素
 *    时间戳，服务端无法判断谁更新；硬猜会把旧值写回，比整块覆盖更危险。
 *    同 id 的并发修改仍按「后到覆盖」，这是已知且可接受的取舍。
 */
function mergeArrayById(base, incoming) {
  if (!Array.isArray(base) || !Array.isArray(incoming)) return null;
  const keyOf = item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (typeof item.id === 'string' && item.id) return item.id;
    if (typeof item.taskId === 'string' && item.taskId) return 'task:' + item.taskId;
    return null;
  };
  const baseKeyed = base.every(item => keyOf(item) !== null);
  const incomingKeyed = incoming.every(item => keyOf(item) !== null);
  if (!baseKeyed || !incomingKeyed) return null;

  const incomingIds = new Set(incoming.map(keyOf));
  // base 里「incoming 没提到」的元素要保留（它们是被另一台设备改的）
  const survivors = base.filter(item => !incomingIds.has(keyOf(item)));
  if (!survivors.length) return null;   // 没有额外元素，走普通覆盖即可

  const merged = [];
  const placed = new Set();
  // 先按 incoming 的顺序放（它代表本次提交的最终意图与排序）
  incoming.forEach(item => {
    const k = keyOf(item);
    merged.push(item);
    placed.add(k);
  });
  // 再把 base 中未被提及的元素补回（保持它们在 base 里的相对顺序）
  base.forEach(item => {
    const k = keyOf(item);
    if (placed.has(k)) return;
    merged.push(item);
    placed.add(k);
  });
  return merged;
}

function setAt(root, path, value) {
  if (!path.length) return clone(value);
  const parent = getParent(root, path.slice(0, -1), true);
  if (!parent) return root;
  const key = path[path.length - 1];
  const prev = parent[key];
  // 同一天的 tasks / partialFocus：只要两边都能按 id 对齐，就按元素合并，
  // 而不是让后到的整块覆盖先到的（两台设备各改一条任务时不再互相抹掉）。
  if (Array.isArray(prev) && Array.isArray(value) && ARRAY_ID_KEYS.indexOf(key) >= 0) {
    const merged = mergeArrayById(prev, value);
    if (merged) { parent[key] = merged; return root; }
  }
  parent[key] = clone(value);
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

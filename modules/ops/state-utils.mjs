import { createHash } from 'node:crypto';

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])])
  );
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

export function sha256Hex(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return createHash('sha256').update(value).digest('hex');
  }
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

export function hashJson(value) {
  return sha256Hex(stableStringify(value));
}

export function summarizeJsonValue(value) {
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      count: value.length,
    };
  }
  if (value && typeof value === 'object') {
    return {
      kind: 'object',
      count: Object.keys(value).length,
    };
  }
  if (value === null || value === undefined) {
    return {
      kind: 'empty',
      count: 0,
    };
  }
  return {
    kind: typeof value,
    count: 1,
  };
}

export function sampleJsonHashes(value, limit = 5) {
  if (Array.isArray(value)) {
    return value.slice(0, limit).map((item, index) => ({
      key: String(index),
      hash: hashJson(item),
    }));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .slice(0, limit)
      .map((key) => ({
        key,
        hash: hashJson(value[key]),
      }));
  }
  return [{
    key: 'value',
    hash: hashJson(value),
  }];
}

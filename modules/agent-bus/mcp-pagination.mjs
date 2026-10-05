export const DEFAULT_LIST_LIMIT = 25;
export const PAGE_PROPERTIES = {
  limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Page size; defaults to 25.' },
  offset: { type: 'integer', minimum: 0, description: 'Page offset; defaults to 0.' },
};

export function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, 200) : fallback;
}

export function normalizeOffset(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function paginate(items = [], { limit, offset } = {}) {
  limit = normalizeLimit(limit);
  offset = normalizeOffset(offset);
  const page = items.slice(offset, offset + limit);
  const hasMore = offset + page.length < items.length;
  return { total: items.length, limit, offset, hasMore, items: page,
    ...(hasMore ? { nextOffset: offset + page.length } : {}) };
}

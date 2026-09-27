import { unsupportedCapability } from './agent-transport.mjs';

export const PROMPT_BLOCK_TYPES = Object.freeze([
  'text', 'image', 'audio', 'embedded_resource', 'resource_link',
]);

export const DEFAULT_ATTACHMENT_MIME_TYPES = Object.freeze([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'audio/mpeg', 'audio/wav', 'audio/ogg',
  'application/pdf', 'application/json', 'text/plain',
]);

const SAFE_RESOURCE_PROTOCOLS = new Set(['http:', 'https:', 'urn:']);

function invalidPromptBlock(message, code = 'invalid_prompt_block') {
  const error = new TypeError(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function safeResourceUri(value, field) {
  const uri = typeof value === 'string' ? value.trim() : '';
  let parsed;
  try { parsed = new URL(uri); } catch { /* handled below */ }
  if (!uri || !parsed || !SAFE_RESOURCE_PROTOCOLS.has(parsed.protocol)) {
    throw invalidPromptBlock(`${field} must be an absolute http(s) or urn URI`, 'unsafe_resource_uri');
  }
  return uri;
}

function decodedBase64(value, field, maxBytes) {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0) {
    throw invalidPromptBlock(`${field} must be non-empty canonical base64`, 'attachment_invalid_base64');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedBytes = ((value.length / 4) * 3) - padding;
  if (decodedBytes > maxBytes) {
    const error = invalidPromptBlock(`Attachment exceeds the ${maxBytes}-byte file limit`, 'attachment_file_quota_exceeded');
    error.statusCode = 413;
    throw error;
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.toString('base64') !== value) {
    throw invalidPromptBlock(`${field} must be non-empty canonical base64`, 'attachment_invalid_base64');
  }
  return bytes;
}

function attachmentMime(block, negotiated, expectedPrefix) {
  const mimeType = typeof block?.mimeType === 'string' ? block.mimeType.trim().toLowerCase() : '';
  if (!mimeType || (expectedPrefix && !mimeType.startsWith(expectedPrefix))) {
    throw invalidPromptBlock(`${block?.type || 'attachment'} mimeType is invalid`, 'attachment_type_mismatch');
  }
  if (!negotiated.mimeAllowlist.includes(mimeType)) {
    const error = invalidPromptBlock(`MIME type is not negotiated: ${mimeType}`, 'attachment_mime_unsupported');
    error.statusCode = 415;
    throw error;
  }
  return mimeType;
}

function assertAttachmentSize(bytes, negotiated) {
  if (bytes.length > negotiated.maxBytes) {
    const error = invalidPromptBlock(`Attachment exceeds the ${negotiated.maxBytes}-byte file limit`, 'attachment_file_quota_exceeded');
    error.statusCode = 413;
    throw error;
  }
}

function positiveLimit(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function intersection(left = [], right = []) {
  const allowed = new Set((right || []).map(String));
  return [...new Set((left || []).map(String))].filter((value) => allowed.has(value));
}

function minLimit(left, right) {
  const a = positiveLimit(left);
  const b = positiveLimit(right);
  if (!a || !b) return 0;
  return Math.min(a, b);
}

export function normalizePromptCapabilities(value = {}) {
  const types = [...new Set(Array.isArray(value.types) ? value.types.map(String) : ['text'])]
    .filter((type) => PROMPT_BLOCK_TYPES.includes(type));
  if (!types.includes('text')) types.unshift('text');
  return Object.freeze({
    types: Object.freeze(types),
    deliveryMode: value.deliveryMode === 'reference' ? 'reference' : 'inline',
    mimeAllowlist: Object.freeze([...new Set((value.mimeAllowlist || []).map((mime) => String(mime).toLowerCase()))]),
    maxBytes: positiveLimit(value.maxBytes),
    maxCount: positiveLimit(value.maxCount),
    maxSessionBytes: positiveLimit(value.maxSessionBytes),
  });
}

/** Fleet may narrow a transport but never advertise more than either side supports. */
export function negotiatePromptCapabilities(transport, policy) {
  const left = normalizePromptCapabilities(transport);
  const right = normalizePromptCapabilities(policy);
  const deliveryMatches = left.deliveryMode === right.deliveryMode;
  const types = deliveryMatches
    ? intersection(left.types, right.types)
    : intersection(left.types, right.types).filter((type) => ['text', 'resource_link'].includes(type));
  if (!types.includes('text')) types.unshift('text');
  const attachmentTypes = types.filter((type) => !['text', 'resource_link'].includes(type));
  return normalizePromptCapabilities({
    types,
    deliveryMode: deliveryMatches ? left.deliveryMode : 'inline',
    mimeAllowlist: attachmentTypes.length ? intersection(left.mimeAllowlist, right.mimeAllowlist) : [],
    maxBytes: attachmentTypes.length ? minLimit(left.maxBytes, right.maxBytes) : 0,
    maxCount: attachmentTypes.length ? minLimit(left.maxCount, right.maxCount) : 0,
    maxSessionBytes: attachmentTypes.length ? minLimit(left.maxSessionBytes, right.maxSessionBytes) : 0,
  });
}

export function assertPromptBlocksSupported(blocks, capabilities) {
  if (!Array.isArray(blocks) || blocks.length === 0) throw new TypeError('prompt blocks are required');
  const negotiated = normalizePromptCapabilities(capabilities);
  let attachmentCount = 0;
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) throw invalidPromptBlock('Each prompt block must be an object');
    const type = String(block?.type || '');
    if (!PROMPT_BLOCK_TYPES.includes(type)) throw unsupportedCapability(`prompt.${type || 'unknown'}`);
    if (!negotiated.types.includes(type)) throw unsupportedCapability(`prompt.${type}`);
    if (type === 'text') {
      if (typeof block.text !== 'string' || !block.text.trim()) throw invalidPromptBlock('text prompt blocks cannot be empty');
    } else if (type === 'resource_link') {
      safeResourceUri(block.uri, 'resource_link uri');
    } else if (type === 'image' || type === 'audio') {
      attachmentMime(block, negotiated, `${type}/`);
      decodedBase64(block.data, `${type} data`, negotiated.maxBytes);
    } else if (type === 'embedded_resource') {
      const resource = block.resource;
      if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
        throw invalidPromptBlock('embedded_resource resource must be an object');
      }
      safeResourceUri(resource.uri, 'embedded_resource uri');
      const mimeType = attachmentMime({ type, mimeType: resource.mimeType }, negotiated);
      const hasText = Object.hasOwn(resource, 'text');
      const hasBlob = Object.hasOwn(resource, 'blob');
      if (hasText === hasBlob) throw invalidPromptBlock('embedded_resource requires exactly one of text or blob');
      let bytes;
      if (hasText) {
        if (typeof resource.text !== 'string' || !resource.text.length) throw invalidPromptBlock('embedded_resource text cannot be empty');
        bytes = Buffer.from(resource.text, 'utf8');
      } else {
        bytes = decodedBase64(resource.blob, 'embedded_resource blob', negotiated.maxBytes);
      }
      if (!mimeType) throw invalidPromptBlock('embedded_resource mimeType is required');
      assertAttachmentSize(bytes, negotiated);
    }
    if (!['text', 'resource_link'].includes(type)) attachmentCount += 1;
  }
  if (attachmentCount > negotiated.maxCount) {
    const error = new Error(`Prompt attachment count exceeds the ${negotiated.maxCount}-item limit`);
    error.code = 'attachment_turn_quota_exceeded';
    error.statusCode = 413;
    throw error;
  }
  return negotiated;
}

function dataUrl(block) {
  return `data:${block.mimeType};base64,${block.data}`;
}

/** Future Codex app-server v2 UserInput mapping helper; not a live transport. */
export function mapPromptBlocksForCodex(blocks) {
  return blocks.map((block) => {
    if (block.type === 'text') return { type: 'text', text: String(block.text), text_elements: [] };
    if (block.type === 'image') return { type: 'image', url: dataUrl(block) };
    if (block.type === 'audio') return { type: 'audio', url: dataUrl(block) };
    throw unsupportedCapability(`codex.prompt.${block.type}`);
  });
}

/** Claude stream-json UserMessage mapping helper. */
export function mapPromptBlocksForClaude(blocks) {
  return blocks.map((block) => {
    if (block.type === 'text') return { type: 'text', text: String(block.text) };
    if (block.type === 'image') {
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.mimeType, data: block.data },
      };
    }
    throw unsupportedCapability(`claude.prompt.${block.type}`);
  });
}

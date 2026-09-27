import { basename } from 'node:path';

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function decodeDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) throw new Error('Expected a base64 image data URL');
  return {
    mimeType: match[1],
    base64: match[2],
  };
}

export async function saveImageToWorkspace({
  workDir = process.cwd(),
  imageDataUrl,
  filenameHint = '',
  sessionId,
  attachmentStore,
  allowCompatibilityDowngrade = false,
} = {}) {
  if (!allowCompatibilityDowngrade) {
    const error = new Error('This transport requires an explicit compatibility-downgrade opt-in for image references');
    error.code = 'unsupported_capability';
    error.statusCode = 400;
    throw error;
  }
  if (!attachmentStore) throw new Error('Fleet AttachmentStore is required for image handoff');
  const decoded = decodeDataUrl(imageDataUrl);
  const [block] = await attachmentStore.ingestTurn(String(sessionId || ''), [{
    type: 'image', data: decoded.base64, mimeType: decoded.mimeType, name: filenameHint || 'image',
  }]);
  const imagePath = await attachmentStore.materializeForWorkdir({
    sessionId: String(sessionId || ''), digest: block.attachment.digest, workDir,
  });
  return {
    imagePath,
    filename: basename(imagePath),
    mimeType: block.attachment.mimeType,
    byteLength: block.attachment.bytes,
    digest: block.attachment.digest,
  };
}

export function buildAgentImagePrompt({
  imagePath,
  caption = '',
  instruction = '',
} = {}) {
  const lines = [
    '[Cadre compatibility notice: this transport cannot accept a typed image block, so the explicitly permitted workdir-scoped reference below is being used.]',
    `An image has been added to the workspace for you at: ${imagePath}`,
    'Inspect that image directly from the local filesystem before continuing.',
  ];
  const normalizedCaption = normalizeText(caption);
  if (normalizedCaption) {
    lines.push('', 'Context from the user:', normalizedCaption);
  }
  const normalizedInstruction = normalizeText(instruction);
  if (normalizedInstruction) {
    lines.push('', normalizedInstruction);
  } else {
    lines.push('', 'Use the image as part of your next response or task.');
  }
  return lines.join('\n');
}

export function buildImageAttachmentResult({ imagePath, filename, mimeType, byteLength, prompt }) {
  return {
    ok: true,
    imagePath,
    filename: basename(filename || imagePath || ''),
    mimeType,
    byteLength,
    prompt,
  };
}

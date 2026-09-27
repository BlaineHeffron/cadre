#!/usr/bin/env node

export const REQUIRED_NODE_VERSION = '22.19.0';

export function compareVersions(left = '', right = '') {
  const parse = (value) => String(value || '').replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10));
  const leftParts = parse(left);
  const rightParts = parse(right);
  if ([...leftParts, ...rightParts].some((part) => !Number.isInteger(part) || part < 0)) return null;
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

if ((compareVersions(process.versions.node, REQUIRED_NODE_VERSION) ?? -1) < 0) {
  console.error(`Node.js >=${REQUIRED_NODE_VERSION} is required; found ${process.version}`);
  process.exit(1);
}

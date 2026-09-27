import { hashJson, sampleJsonHashes, summarizeJsonValue } from './state-utils.mjs';

export function buildParityEntry(namespace, sourceValue, targetValue) {
  const sourceSummary = summarizeJsonValue(sourceValue);
  const targetSummary = summarizeJsonValue(targetValue);
  const sourceHash = hashJson(sourceValue);
  const targetHash = hashJson(targetValue);
  return {
    namespace,
    source: {
      ...sourceSummary,
      hash: sourceHash,
      samples: sampleJsonHashes(sourceValue),
    },
    target: {
      ...targetSummary,
      hash: targetHash,
      samples: sampleJsonHashes(targetValue),
    },
    matches: sourceHash === targetHash,
  };
}

export function buildParityReport(entries, threshold = 1) {
  const normalizedEntries = Array.isArray(entries) ? entries : [];
  const passed = normalizedEntries.filter((entry) => entry.matches).length;
  const total = normalizedEntries.length;
  const parityScore = total > 0 ? passed / total : 1;
  const ok = parityScore >= Number(threshold || 1);
  return {
    generatedAt: new Date().toISOString(),
    threshold: Number(threshold || 1),
    parityScore,
    passed,
    failed: total - passed,
    total,
    ok,
    rollbackRecommended: !ok,
    entries: normalizedEntries,
  };
}

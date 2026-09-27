export async function settleWithConcurrency(items, task, {
  concurrency = 4,
  onProgress = null,
} = {}) {
  const queue = Array.from(items || []);
  if (typeof task !== 'function') throw new TypeError('task must be a function');
  if (queue.length === 0) return [];

  const requestedConcurrency = Number.parseInt(concurrency, 10);
  const workerCount = Math.min(
    queue.length,
    Number.isFinite(requestedConcurrency) ? Math.max(1, requestedConcurrency) : 1,
  );
  const results = new Array(queue.length);
  let nextIndex = 0;
  let completed = 0;

  async function runWorker() {
    while (nextIndex < queue.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: 'fulfilled', value: await task(queue[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
      completed += 1;
      onProgress?.({ completed, total: queue.length, index, result: results[index] });
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

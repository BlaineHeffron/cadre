// Room metadata.task predates durable orchestration and may contain arbitrary data.
export const DURABLE_TASK_RECORD_TYPE = 'dueno.durable-task.v1';
export const isDurableTaskRecord = (value) => value?.recordType === DURABLE_TASK_RECORD_TYPE;

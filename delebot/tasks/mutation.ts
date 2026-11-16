const queues = new Map<string, Promise<void>>();

export class TaskLockTimeoutError extends Error {
  constructor() {
    super("This task is busy with another change. Please try again shortly.");
  }
}

/** Serialize this runtime's task work; bounded waits cannot strand a workflow.
 * Never reacquire the same key inside an operation. Slack datastores do not
 * provide the conditional writes needed for a distributed lock.
 */
export async function withKeyLock<T>(
  key: string,
  operation: () => Promise<T>,
  waitMs = 5000,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  // A timed-out waiter must not let its successors overtake the active holder.
  const barrier = previous.then(() => current);
  queues.set(key, barrier);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TaskLockTimeoutError()), waitMs);
      }),
    ]);
    clearTimeout(timer);
    return await operation();
  } finally {
    clearTimeout(timer);
    release();
    void barrier.then(() => {
      if (queues.get(key) === barrier) queues.delete(key);
    });
  }
}

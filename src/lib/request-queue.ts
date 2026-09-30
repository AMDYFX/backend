import { logger } from "./logger";

interface QueueEntry {
  promise: Promise<unknown>;
  timestamp: number;
}

const queues = new Map<number, QueueEntry>();

/** Default TTL for successful cache entries in milliseconds (30 seconds) */
const CACHE_TTL_MS = 30_000;

/**
 * Serialize concurrent requests for the same project.
 * The first request executes the handler; subsequent requests
 * within the cache window share the same result.
 * Failed requests are not cached, allowing fresh attempts.
 */
export async function withProjectLock<T>(
  projectId: number,
  handler: () => Promise<T>,
): Promise<T> {
  const existing = queues.get(projectId);

  if (existing) {
    const age = Date.now() - existing.timestamp;
    
    // Check if cached entry has expired
    if (age >= CACHE_TTL_MS) {
      logger.debug("Cached entry expired, removing", { projectId, age });
      queues.delete(projectId);
    } else {
      logger.debug("Request queued, waiting for in-flight", { projectId });
      return existing.promise as Promise<T>;
    }
  }

  const entry: QueueEntry = { 
    promise: handler(), 
    timestamp: Date.now() 
  };
  queues.set(projectId, entry);

  try {
    const result = await entry.promise;
    // Keep successful result in cache for deduplication
    return result as T;
  } catch (error) {
    // Remove failed entry immediately so next caller gets a fresh attempt
    queues.delete(projectId);
    throw error;
  } finally {
    // Schedule cleanup after TTL
    setTimeout(() => {
      const current = queues.get(projectId);
      if (current === entry) {
        queues.delete(projectId);
      }
    }, CACHE_TTL_MS);
  }
}

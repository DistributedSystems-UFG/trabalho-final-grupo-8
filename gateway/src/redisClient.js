/**
 * @file redisClient.js
 * @description Singleton Redis client for the Gateway, backed by ioredis.
 *
 * Used exclusively for distributed Optimistic Concurrency Control (OCC) in
 * Phase 7 — replaces the in-memory versionMap from chunkVersionManager so
 * that all Gateway replicas share the same authoritative version state.
 *
 * ioredis reconnects automatically on connection loss with exponential
 * back-off (default: up to 30 retries) and queues commands during reconnect
 * windows, so callers do not need to handle reconnect logic manually.
 *
 * Responsibilities (SRP):
 *  - Instantiate and export the ioredis client singleton.
 *  - Expose a graceful disconnect for shutdown hooks.
 */

const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';

/**
 * Shared ioredis client.
 * Commands issued while Redis is unreachable are queued and replayed once the
 * connection is re-established, ensuring no stroke OCC calls are silently lost.
 *
 * @type {import('ioredis').Redis}
 */
const redis = new Redis(REDIS_URL, {
  // Keep commands queued while reconnecting so strokes are not silently dropped.
  enableOfflineQueue: true,
  maxRetriesPerRequest: null,
});

redis.on('connect', () => console.log('[redisClient] connected to Redis.'));
redis.on('reconnecting', () => console.warn('[redisClient] reconnecting to Redis…'));
redis.on('error', (err) => console.error('[redisClient] error:', err.message));

/**
 * Gracefully closes the Redis connection.
 * Call this during Gateway graceful shutdown (index.js SIGTERM/SIGINT).
 *
 * @returns {Promise<void>}
 */
async function close() {
  await redis.quit();
  console.log('[redisClient] connection closed.');
}

module.exports = { redis, close };

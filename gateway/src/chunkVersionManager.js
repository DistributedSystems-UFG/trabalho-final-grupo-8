/**
 * @file chunkVersionManager.js
 * @description Distributed Optimistic Concurrency Control (OCC) version store
 * for canvas chunks, backed by Redis.
 *
 * ── Why OCC (Optimistic Locking) and NOT PCC (Pessimistic Locking)? ──────────
 *
 * Pessimistic Concurrency Control would require acquiring a mutex or DB row-
 * lock *before* processing each stroke, serialising all writers on the same
 * chunk.  Under the Aquarela.io workload — many users painting rapidly — this
 * turns the Gateway into a bottleneck: each stroke_event would stall waiting
 * for the previous holder to release the lock, degrading latency for all
 * participants even when conflicts are rare.
 *
 * Optimistic Concurrency Control assumes conflicts are the exception, not the
 * rule.  Each client tracks the last-known version of every chunk it has
 * painted.  The Gateway checks the version in O(1) and either:
 *   • accepts the stroke (versions match) — bumps the version and continues.
 *   • rejects the stroke (versions diverge) — returns a conflict_event so the
 *     client can update its local version and re-paint.
 *
 * ── Why Redis for Phase 7? ────────────────────────────────────────────────────
 *
 * The original in-memory Map worked correctly when the Gateway ran as a single
 * process.  With 3 replicas behind an Nginx load balancer, each process has its
 * own version counter: instance A accepts version 5→6, but instance B still
 * reads 5 and also accepts a conflicting stroke at 5→6.  OCC is broken.
 *
 * Redis fixes this with a single shared version store.  The critical section
 * (compare-and-increment) is implemented as a Lua script, which Redis executes
 * atomically — no two scripts for the same key can interleave.  This gives the
 * same correctness guarantee as the single-process synchronous Map lookup, now
 * across N replicas.
 *
 * ── Why Lua scripts and not WATCH/MULTI/EXEC? ────────────────────────────────
 *
 * WATCH/MULTI/EXEC requires multiple round-trips to Redis and client-side retry
 * logic on transaction abort.  A Lua script executes atomically in a single
 * round-trip, making it both simpler and faster on this hot path (every accepted
 * stroke triggers a version check).
 *
 * Responsibilities (SRP):
 *  - Maintain a per-(roomId, chunkId) version counter in Redis.
 *  - Seed versions from the database on Gateway restart (via initChunk).
 *  - Expose tryAcceptStroke() as the single async OCC decision point.
 *  - Version keys expire automatically via TTL — clearRoom is a no-op.
 */

const { redis } = require('./redisClient');

/**
 * TTL applied to every version key on write.
 * 24 hours is sufficient for a room session; keys are auto-purged by Redis
 * when they expire, preventing unbounded key accumulation without requiring
 * explicit cleanup calls that would be unsafe in a multi-instance deployment.
 */
const VERSION_KEY_TTL_SECONDS = 86_400;

/**
 * Redis key for a chunk version counter.
 *
 * @param {string} roomId
 * @param {string} chunkId
 * @returns {string}
 */
function versionKey(roomId, chunkId) {
  return `chunk:${roomId}:${chunkId}:version`;
}

/**
 * Lua script: set the version key to Math.max(current, candidate) atomically.
 *
 * Called when a client joins and hydrates versions from the DB.  The Lua
 * script prevents a stale DB value from overwriting a version that another
 * instance has already advanced in Redis — the higher value always wins.
 *
 * KEYS[1] — the Redis key for this chunk's version.
 * ARGV[1] — the candidate version (from the DB).
 * ARGV[2] — TTL in seconds (refreshed on every write).
 *
 * Returns the version stored after the operation.
 */
const INIT_CHUNK_SCRIPT = `
  local current = tonumber(redis.call('GET', KEYS[1]))
  local candidate = tonumber(ARGV[1])
  local ttl = tonumber(ARGV[2])
  if not current or candidate > current then
    redis.call('SET', KEYS[1], candidate, 'EX', ttl)
    return candidate
  else
    redis.call('EXPIRE', KEYS[1], ttl)
    return current
  end
`;

/**
 * Lua script: atomic compare-and-increment for OCC.
 *
 * Checks whether the stored version equals the client's version.
 *  - Match   → increments the version and returns { 1, newVersion }.
 *  - Mismatch → returns { 0, currentVersion } without modifying Redis.
 *
 * Redis executes Lua scripts atomically: no two concurrent EVAL calls for the
 * same key can interleave, giving the same correctness guarantee as the former
 * single-process synchronous Map check across all Gateway replicas.
 *
 * KEYS[1] — the Redis key for this chunk's version.
 * ARGV[1] — the client's reported version.
 * ARGV[2] — TTL in seconds (refreshed on every accepted stroke).
 */
const TRY_ACCEPT_SCRIPT = `
  local raw = redis.call('GET', KEYS[1])
  local stored = raw and tonumber(raw) or 0
  local client = tonumber(ARGV[1])
  local ttl = tonumber(ARGV[2])
  if stored == client then
    local newVersion = stored + 1
    redis.call('SET', KEYS[1], newVersion, 'EX', ttl)
    return {1, newVersion}
  else
    return {0, stored}
  end
`;

/**
 * Seeds the Redis version for a specific chunk, taking the maximum of the
 * current Redis value and the DB-persisted value.
 *
 * Idempotent and safe to call concurrently from multiple Gateway replicas —
 * the Lua script ensures the higher value always wins, so a stale DB read
 * from one instance never downgrades a version already advanced by another.
 *
 * @param {string} roomId   - Room that owns the chunk.
 * @param {string} chunkId  - Chunk identifier (e.g. "0_0").
 * @param {number} version  - The version number to seed (typically from DB).
 * @returns {Promise<void>}
 */
async function initChunk(roomId, chunkId, version) {
  const key = versionKey(roomId, chunkId);
  await redis.eval(
    INIT_CHUNK_SCRIPT,
    1,
    key,
    String(Number(version)),
    String(VERSION_KEY_TTL_SECONDS),
  );
}

/**
 * Atomically validates and accepts (or rejects) an incoming stroke based on
 * its client-reported version.
 *
 * OCC decision logic (enforced in Redis via Lua, atomically across all
 * Gateway replicas):
 *  - versions match   → stroke accepted, version incremented.
 *  - versions differ  → stroke rejected, current version returned.
 *
 * @param {string} roomId        - Room that owns the chunk.
 * @param {string} chunkId       - Chunk the stroke targets.
 * @param {number} clientVersion - The version the client believed was current.
 * @returns {Promise<{ accepted: boolean, currentVersion: number }>}
 *   `accepted` is true if the stroke was accepted and the version was bumped.
 *   `currentVersion` is the authoritative version after the operation:
 *     - on accept: the newly incremented version.
 *     - on reject: the current version the client should sync to.
 */
async function tryAcceptStroke(roomId, chunkId, clientVersion) {
  const key = versionKey(roomId, chunkId);
  const result = await redis.eval(
    TRY_ACCEPT_SCRIPT,
    1,
    key,
    String(clientVersion),
    String(VERSION_KEY_TTL_SECONDS),
  );

  return {
    accepted: result[0] === 1,
    currentVersion: Number(result[1]),
  };
}

/**
 * Returns the current version for a chunk from Redis.
 * Returns 0 if the key does not exist (chunk never painted).
 *
 * @param {string} roomId  - Room that owns the chunk.
 * @param {string} chunkId - Chunk identifier.
 * @returns {Promise<number>}
 */
async function getVersion(roomId, chunkId) {
  const raw = await redis.get(versionKey(roomId, chunkId));
  return raw ? Number(raw) : 0;
}

/**
 * No-op in Phase 7 (multi-instance deployment).
 *
 * ── Design decision ──────────────────────────────────────────────────────────
 * In the single-process implementation, clearRoom deleted in-memory entries
 * when the last local client left a room.  In a multi-instance deployment,
 * this is unsafe: instance A's local room becoming empty does not mean the
 * room is globally empty — instances B and C may still have active clients
 * processing strokes against the same Redis version keys.  Deleting those
 * keys from instance A would reset versions to 0, corrupting OCC for other
 * instances.
 *
 * Version keys are managed via TTL (VERSION_KEY_TTL_SECONDS = 24 h) and are
 * auto-purged by Redis.  No explicit cleanup is needed or safe here.
 *
 * @param {string} _roomId - Unused in Phase 7.
 */
function clearRoom(_roomId) {
  // Intentional no-op — see JSDoc above.
}

module.exports = { initChunk, tryAcceptStroke, getVersion, clearRoom };

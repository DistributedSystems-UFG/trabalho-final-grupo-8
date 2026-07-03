/**
 * @file index.js
 * @description Gateway entry point — bootstraps the HTTP/WebSocket server.
 * Full implementation is added in Phase 1 (WebSocket + Rooms).
 * Phase 3 adds PostgreSQL connection eagerness and write-batcher lifecycle.
 */

require('dotenv').config();

const http = require('http');
const { initWsServer } = require('./wsServer');

// Eagerly require the pool so the process fails fast if env vars are missing
// rather than silently operating without persistence.
const { pool, readPool } = require('./db/pool');
const writeBatcher = require('./writeBatcher');
const simulationBatcher = require('./simulationBatcher');
const rabbitClient = require('./rabbitClient');
const { startSimulationResultsConsumer } = require('./simulationResultsConsumer');
const roomManager = require('./roomManager');
// Import redisClient eagerly so the connection is established at boot time
// and version key operations are ready before the first stroke arrives.
const redisClient = require('./redisClient');
const { INSTANCE_ID } = require('./roomBroadcastBus');

const PORT = process.env.GATEWAY_PORT || 3000;
const BATCH_FLUSH_INTERVAL_MS = Number(process.env.BATCH_FLUSH_INTERVAL_MS) || 5_000;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'aquarela-gateway' }));
});

initWsServer(server);

server.listen(PORT, () => {
  console.log(`[gateway] HTTP server listening on port ${PORT} (instance=${INSTANCE_ID})`);

  // Verify the DB connection is reachable before accepting traffic.
  pool.query('SELECT 1').then(() => {
    console.log('[gateway] PostgreSQL primary connection verified.');
  }).catch((err) => {
    console.error('[gateway] PostgreSQL primary connection failed:', err.message);
    // Do not exit — the server can still serve WebSocket connections;
    // write-batcher flushes will fail and log until the DB recovers.
  });

  // Non-fatal replica check: if the read replica has not finished bootstrapping
  // (pg_basebackup can take a moment), fetchRoomChunks falls back to the primary
  // until it is ready, so a warning here is informational only.
  readPool.query('SELECT 1').then(() => {
    console.log('[gateway] PostgreSQL read-replica connection verified.');
  }).catch((err) => {
    console.warn(
      `[gateway] PostgreSQL read-replica not ready (${err.message}) — reads fall back to primary.`
    );
  });

  // Start the periodic write-batcher flush loop.
  writeBatcher.startFlushTimer(BATCH_FLUSH_INTERVAL_MS);

  // Connect to RabbitMQ and start the simulation results consumer.
  // Non-fatal: if RabbitMQ is unavailable, stroke painting still works;
  // only fluid diffusion effects will be absent until the connection recovers.
  rabbitClient.connect()
    .then(() => {
      startSimulationResultsConsumer(roomManager);
      console.log('[gateway] RabbitMQ connected and simulation results consumer started.');
    })
    .catch((err) => {
      console.error('[gateway] RabbitMQ connection failed:', err.message);
    });
});

/**
 * Graceful shutdown: flush all pending strokes before the process exits.
 * Ensures minimal data loss when the container is stopped (SIGTERM from
 * Docker / Kubernetes) or the process is interrupted (SIGINT from CLI).
 */
async function gracefulShutdown(signal) {
  console.log(`[gateway] ${signal} received — starting graceful shutdown…`);
  try {
    await writeBatcher.flushAll();
    simulationBatcher.flushAll();
    await rabbitClient.close();
    await redisClient.close();
    await pool.end();
    await readPool.end();
    console.log('[gateway] PostgreSQL pools closed. Bye!');
  } catch (err) {
    console.error('[gateway] error during shutdown:', err.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));


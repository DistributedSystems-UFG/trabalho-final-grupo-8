/**
 * @file pool.js
 * @description Singleton pg.Pool for the Aquarela.io Gateway.
 *
 * A single Pool instance is shared across the entire process lifetime.
 * Using a singleton avoids exhausting the PostgreSQL max_connections limit
 * and removes the overhead of establishing a new TCP handshake per query.
 *
 * Phase 7 — Read-Replica (Replicação de dados):
 *   `pool`      → primário (read-write): recebe todas as escritas (upsertChunk).
 *   `readPool`  → réplica read-only (POSTGRES_READ_HOST): serve os SELECTs de
 *                 restauração de canvas (fetchRoomChunks), aliviando o primário.
 *   Se POSTGRES_READ_HOST não estiver definido, `readPool` aponta para o mesmo
 *   host do primário — assim o modo single-node de desenvolvimento continua
 *   funcionando sem exigir uma réplica no ar.
 */

const { Pool } = require('pg');

// Configuração comum aos dois pools, sempre vinda de variáveis de ambiente para
// que nenhuma credencial apareça no código (OWASP A02 — Cryptographic Failures).
const BASE_CONFIG = {
  port: Number(process.env.POSTGRES_PORT) || 5432,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  // Keep the pool small: the Gateway is I/O-bound, not CPU-bound, so a
  // handful of connections is sufficient and avoids saturating the DB server.
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
};

/**
 * Connection pool for the primary (read-write) PostgreSQL instance.
 * All writes (upsertChunk) target this pool.
 *
 * @type {import('pg').Pool}
 */
const pool = new Pool({ ...BASE_CONFIG, host: process.env.POSTGRES_HOST });

/**
 * Connection pool for the read-only replica.
 *
 * Falls back to the primary host when POSTGRES_READ_HOST is unset, so a
 * single-node deployment behaves identically without a replica present.
 *
 * @type {import('pg').Pool}
 */
const readPool = new Pool({
  ...BASE_CONFIG,
  host: process.env.POSTGRES_READ_HOST || process.env.POSTGRES_HOST,
});

pool.on('error', (err) => {
  console.error('[db/pool] Unexpected error on idle primary PostgreSQL client:', err.message);
});

readPool.on('error', (err) => {
  console.error('[db/pool] Unexpected error on idle replica PostgreSQL client:', err.message);
});

module.exports = { pool, readPool };

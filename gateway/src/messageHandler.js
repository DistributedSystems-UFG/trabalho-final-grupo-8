/**
 * @file messageHandler.js
 * @description Routes incoming WebSocket messages to the appropriate handler
 * based on the `type` field in the JSON payload.
 *
 * Responsibilities (SRP):
 *  - Parse raw message buffers into JSON.
 *  - Validate minimum required fields per message type.
 *  - Dispatch to the correct domain handler.
 *  - Send structured `error` responses for invalid payloads.
 *
 * This module does NOT manage room state directly — it delegates to roomManager.
 */

/**
 * @typedef {import('ws').WebSocket} WebSocket
 * @typedef {import('./roomManager')} RoomManager
 */

const writeBatcher = require('./writeBatcher');
const { fetchRoomChunks } = require('./db/chunkRepository');
const chunkVersionManager = require('./chunkVersionManager');
const simulationBatcher = require('./simulationBatcher');
const roomBroadcastBus = require('./roomBroadcastBus');

/**
 * Sends a structured error message back to a single client.
 *
 * @param {WebSocket} ws - The client to notify.
 * @param {string} message - Human-readable error description.
 */
function sendError(ws, message) {
  ws.send(JSON.stringify({ type: 'error', message }));
}

/**
 * Handles a `join_room` event from a client.
 *
 * ── Interação SÍNCRONA (bloqueante) — por que aqui? ──────────────────────────
 * Diferente do `stroke_event` (assíncrono/fire-and-forget), o join é o único
 * ponto do sistema que exige interação remota SÍNCRONA/BLOQUEANTE, conforme a
 * especificação: o cliente NÃO pode começar a pintar antes de conhecer o estado
 * atual do canvas e as versões OCC de cada chunk — caso contrário a primeira
 * pincelada carregaria versões erradas e seria rejeitada como conflito.
 *
 * Por isso este handler é `async` e o Gateway BLOQUEIA (await) na leitura do
 * banco (réplica de leitura) + hidratação das versões no Redis, e só então
 * responde uma ÚNICA mensagem `canvas_state` que serve simultaneamente de ACK
 * do join. O cliente aguarda essa resposta (request/reply via correlationId)
 * antes de habilitar o canvas. A leitura sai do `readPool` (réplica), unindo
 * "leitura síncrona" + "replicação de dados" no mesmo fluxo.
 *
 * @param {WebSocket} ws - The connecting client.
 * @param {object} payload - The parsed message payload.
 * @param {string} payload.roomId - Target room identifier.
 * @param {string} payload.userId - Unique identifier of the joining user.
 * @param {string} [payload.correlationId] - Echoed back so the client can match
 *   this blocking request to its `canvas_state` reply.
 * @param {object} roomManager - The roomManager module instance.
 * @returns {Promise<void>}
 */
async function handleJoinRoom(ws, payload, roomManager) {
  const { roomId, userId, correlationId } = payload;

  if (!roomId || typeof roomId !== 'string') {
    return sendError(ws, 'join_room requires a non-empty string roomId.');
  }
  if (!userId || typeof userId !== 'string') {
    return sendError(ws, 'join_room requires a non-empty string userId.');
  }

  // Persist metadata on the socket for use in close/error events.
  ws.userId = userId;
  ws.roomId = roomId;

  const clientCount = roomManager.joinRoom(ws, roomId);

  console.log(`[gateway] user=${userId} joined room=${roomId} (${clientCount} clients)`);

  // Subscribe to this room's fanout exchange when the first client on this
  // instance joins.  The callback broadcasts any cross-instance messages
  // (strokes from other Gateway replicas) to all local WebSocket clients.
  // Fire-and-forget: the subscription is typically ready within milliseconds.
  // The rare race where a remote stroke arrives before subscription completes
  // is acceptable — local strokes and persistence are unaffected.
  if (clientCount === 1) {
    roomBroadcastBus.subscribeToRoom(roomId, (busPayload) => {
      roomManager.broadcastToRoom(roomId, busPayload);
    }).catch((err) => {
      console.error(`[gateway] room bus subscribe failed for room=${roomId}: ${err.message}`);
    });
  }

  // ── Caminho bloqueante: leitura de estado + hidratação de versões ──────────
  // O `await` aqui é intencional — a resposta ao cliente só é enviada quando o
  // estado está pronto (ver JSDoc acima).
  const chunks = await fetchRoomChunks(roomId);

  // Hydrate the Redis OCC version store from the persisted DB versions.
  // Critical on Gateway restart: without hydration, the Redis key for a chunk
  // defaults to 0, causing clients with a non-zero version to receive spurious
  // conflict_events on their first stroke.
  for (const chunk of chunks) {
    await chunkVersionManager.initChunk(roomId, chunk.chunkId, chunk.version ?? 0);
  }

  // Resposta síncrona única (ACK do join): sempre enviada, mesmo para salas
  // novas (chunks vazios), para que a Promise bloqueante do cliente sempre
  // resolva. Carrega `version` por chunk para semear o chunkVersions do cliente
  // e o `correlationId` para casar request/reply.
  ws.send(JSON.stringify({ type: 'canvas_state', roomId, clientCount, chunks, correlationId }));
  console.log(
    `[gateway] canvas_state (join ack) sent to user=${userId} — ${chunks.length} chunk(s) restored`
  );

  // Notify everyone else in the room (não-bloqueante para os demais).
  roomManager.broadcastToRoom(roomId, { type: 'client_joined', userId, clientCount }, ws);
}

/**
 * Handles a `stroke_event` from a client, applying Optimistic Concurrency
 * Control (OCC) before accepting the stroke.
 *
 * OCC decision (why not pessimistic locking):
 *  Pessimistic locking would block the event loop on every stroke while
 *  waiting for a lock release, serialising all painters on the same chunk.
 *  OCC assumes conflicts are rare — it validates the client's `version`
 *  against the in-memory counter (a synchronous Map lookup), rejects stale
 *  strokes instantly, and only notifies the affected client.  All other
 *  clients continue painting without any contention overhead.
 *
 * On ACCEPT:
 *  - The in-memory version for the chunk is atomically incremented.
 *  - A `stroke_ack` carrying the new version is sent back to the sender so
 *    it can advance its local chunkVersions map.
 *  - The stroke is broadcast (with the new version) to all other room members
 *    so they also advance their local chunkVersions maps.
 *  - The stroke is queued in the write-batcher for async DB persistence.
 *
 * On REJECT:
 *  - A `conflict_event` is sent back to the sender with the authoritative
 *    version.  The client updates its local version map and can re-paint.
 *    No broadcast is performed — the stroke never lands on other canvases.
 *
 * @param {WebSocket} ws - The client that sent the stroke.
 * @param {object} payload - The parsed message payload.
 * @param {string} payload.roomId - Room the stroke belongs to.
 * @param {string} payload.userId - Author of the stroke.
 * @param {number} payload.x - Horizontal canvas coordinate.
 * @param {number} payload.y - Vertical canvas coordinate.
 * @param {string} payload.color - CSS hex color string.
 * @param {number} payload.brushSize - Brush radius in pixels.
 * @param {number} [payload.opacity] - Stroke opacity in [0, 1] (defaults to 1).
 * @param {boolean} [payload.eraser] - Whether the stroke erases pigment (defaults to false).
 * @param {number} payload.timestamp - Unix epoch milliseconds.
 * @param {string} payload.chunkId - Canvas chunk identifier (e.g. "0_0").
 * @param {number} payload.version - Client's last-known version for the chunk.
 * @param {object} roomManager - The roomManager module instance.
 */
async function handleStrokeEvent(ws, payload, roomManager) {
  const { roomId, userId, x, y, color, brushSize, timestamp, chunkId } = payload;

  const missingFields = ['roomId', 'userId', 'x', 'y', 'color', 'brushSize', 'timestamp', 'chunkId']
    .filter((field) => payload[field] === undefined || payload[field] === null);

  if (missingFields.length > 0) {
    return sendError(ws, `stroke_event is missing required fields: ${missingFields.join(', ')}.`);
  }

  // Optional brush attributes (added in the Redesign). Defaulted here for
  // backwards compatibility with pre-Redesign clients: opacity=1 (fully
  // opaque), eraser=false (additive stroke). These are threaded through the
  // broadcast, persistence, and simulation paths below.
  const opacity = typeof payload.opacity === 'number' ? payload.opacity : 1;
  const eraser = payload.eraser === true;

  // Treat a missing `version` field as 0 for backwards compatibility with
  // clients that pre-date Phase 5.  In a production rollout this fallback
  // would be removed once all clients are updated.
  const clientVersion = typeof payload.version === 'number' ? payload.version : 0;

  // ── OCC check ────────────────────────────────────────────────────────────
  // tryAcceptStroke is now async: it executes a Lua CAS script in Redis,
  // which is atomic across all Gateway replicas (Phase 7).
  const { accepted, currentVersion } = await chunkVersionManager.tryAcceptStroke(
    roomId,
    chunkId,
    clientVersion
  );

  if (!accepted) {
    // The client's version is stale — another stroke was accepted on this chunk
    // after the client last synced.  Inform the client of the current version
    // so it can reconcile and re-paint if desired.
    console.log(
      `[gateway] conflict rejected stroke — user=${userId} room=${roomId} chunk=${chunkId} ` +
      `clientVersion=${clientVersion} currentVersion=${currentVersion}`
    );

    ws.send(JSON.stringify({
      type: 'conflict_event',
      roomId,
      chunkId,
      rejectedVersion: clientVersion,
      currentVersion,
    }));

    return;
  }

  // ── Accepted ─────────────────────────────────────────────────────────────

  // Acknowledge to the sender with the new authoritative version so it can
  // advance its local chunkVersions map without waiting for its own echo.
  ws.send(JSON.stringify({ type: 'stroke_ack', chunkId, newVersion: currentVersion }));

  // Broadcast the stroke (with its new version) to every OTHER client in the
  // room so they also advance their chunkVersions maps.
  roomManager.broadcastToRoom(
    roomId,
    { type: 'stroke_event', roomId, userId, x, y, color, brushSize, opacity, eraser, timestamp, chunkId, version: currentVersion },
    ws
  );

  // Publish the accepted stroke to the room's RabbitMQ fanout exchange so
  // Gateway instances B and C can broadcast it to their local WebSocket
  // clients.  The originating instance (this one) is excluded via
  // originInstanceId deduplication in roomBroadcastBus.
  // Fire-and-forget: a fanout publish failure does not affect local clients
  // or persistence — only cross-instance delivery is degraded.
  roomBroadcastBus.publishToRoom(roomId, {
    type: 'stroke_event', roomId, userId, x, y, color, brushSize, opacity, eraser, timestamp, chunkId, version: currentVersion,
  }).catch((err) => {
    console.error(`[messageHandler] room fanout publish failed room=${roomId}: ${err.message}`);
  });

  // Queue the accepted stroke for async persistence via the write-batcher.
  // The version is threaded through so the DB mirrors the in-memory state
  // after each flush, enabling correct hydration on Gateway restart.
  writeBatcher.addStroke(roomId, chunkId, { x, y, color, brushSize, opacity, eraser, userId, timestamp }, currentVersion);

  // Enqueue the stroke in the simulation batcher.  The batcher accumulates
  // strokes over a 150 ms window and publishes a single batched job to
  // RabbitMQ, reducing queue pressure from ~30 jobs/s to ~7 jobs/s.
  // Non-blocking and fire-and-forget: a publish failure here does NOT affect
  // the stroke acceptance or persistence paths.
  simulationBatcher.addStroke(roomId, chunkId, { x, y, color, brushSize, opacity, eraser, userId, timestamp });
}

/**
 * Entry point for all incoming WebSocket messages.
 * Parses the raw buffer, validates the `type` field, and dispatches
 * to the correct domain handler.
 *
 * @param {WebSocket} ws - The client that sent the message.
 * @param {Buffer|string} rawMessage - The raw WebSocket message data.
 * @param {object} roomManager - The roomManager module instance.
 */
function handleMessage(ws, rawMessage, roomManager) {
  let payload;

  try {
    payload = JSON.parse(rawMessage.toString());
  } catch {
    return sendError(ws, 'Message must be valid JSON.');
  }

  if (!payload.type || typeof payload.type !== 'string') {
    return sendError(ws, 'Message must include a string "type" field.');
  }

  switch (payload.type) {
    case 'join_room':
      // handleJoinRoom is async (blocking DB read + Redis hydration). Errors are
      // caught here so an unhandled rejection cannot crash the process, and the
      // client is told the blocking join failed (it can retry).
      handleJoinRoom(ws, payload, roomManager).catch((err) => {
        console.error(`[messageHandler] unhandled error in join_room: ${err.message}`);
        sendError(ws, 'Internal server error joining room.');
      });
      break;

    case 'stroke_event':
      // handleStrokeEvent is async (awaits Redis OCC). Errors are caught here
      // to prevent unhandled promise rejections from crashing the process.
      handleStrokeEvent(ws, payload, roomManager).catch((err) => {
        console.error(`[messageHandler] unhandled error in stroke_event: ${err.message}`);
        sendError(ws, 'Internal server error processing stroke.');
      });
      break;

    default:
      sendError(ws, `Unknown message type: "${payload.type}".`);
  }
}

module.exports = { handleMessage };

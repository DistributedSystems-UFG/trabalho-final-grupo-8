/**
 * @file roomBroadcastBus.js
 * @description Per-room RabbitMQ fanout exchange for cross-instance WebSocket
 * broadcast in a multi-replica Gateway deployment.
 *
 * ── Problem ──────────────────────────────────────────────────────────────────
 * With 3 Gateway replicas behind an Nginx load balancer, a stroke accepted by
 * instance A is broadcast only to WebSocket clients connected to instance A.
 * Clients on instances B and C never see the stroke — their canvases diverge.
 *
 * ── Solution ─────────────────────────────────────────────────────────────────
 * Each Gateway instance subscribes to a per-room RabbitMQ fanout exchange
 * (exchange name: `room_fanout.<roomId>`).  When a stroke is accepted or a
 * pixel_update is produced by the Worker:
 *  1. The local roomManager broadcast runs immediately — zero extra latency
 *     for clients already connected to this instance.
 *  2. The message is published to the room's fanout exchange.
 *  3. Every OTHER instance receives the message and rebroadcasts it locally.
 *
 * ── Deduplication ────────────────────────────────────────────────────────────
 * Each message carries an `originInstanceId` field matching the publishing
 * instance's INSTANCE_ID.  The consumer on the originating instance skips
 * messages it published (local clients were already notified in step 1).
 *
 * ── Exchange lifecycle ───────────────────────────────────────────────────────
 * Exchanges are `durable: false, autoDelete: true` — they are removed by
 * RabbitMQ when the last binding is dropped, keeping the broker clean after
 * rooms become idle.  Queues are exclusive and auto-delete so they disappear
 * when the consuming channel closes (e.g. on Gateway shutdown).
 *
 * Responsibilities (SRP):
 *  - Subscribe this instance to a room's fanout exchange.
 *  - Publish messages to a room's fanout exchange.
 *  - Unsubscribe when the local room becomes empty.
 */

const { randomUUID } = require('crypto');
const rabbitClient = require('./rabbitClient');

/**
 * Unique identifier for this Gateway process instance.
 * Used to deduplicate fanout messages that this instance published so that
 * its own local clients are not notified twice.
 *
 * Can be overridden via GATEWAY_INSTANCE_ID env var for deterministic logging
 * in test environments.
 *
 * @type {string}
 */
const INSTANCE_ID = process.env.GATEWAY_INSTANCE_ID || randomUUID();

console.log(`[roomBroadcastBus] instance id: ${INSTANCE_ID}`);

/**
 * @typedef {{ channel: import('amqplib').Channel, consumerTag: string }} Subscription
 */

/**
 * Active fanout subscriptions keyed by roomId.
 * Each entry owns a dedicated AMQP channel (one channel per room).
 *
 * @type {Map<string, Subscription>}
 */
const subscriptions = new Map();

/**
 * Room IDs whose fanout exchange has already been declared on the shared
 * publish channel.  Avoids redundant assertExchange network round-trips on
 * the hot publish path after the first call per room.
 *
 * @type {Set<string>}
 */
const declaredExchanges = new Set();

/**
 * AMQP exchange name for a room's fanout.
 *
 * @param {string} roomId
 * @returns {string}
 */
function exchangeName(roomId) {
  return `room_fanout.${roomId}`;
}

/**
 * Subscribes this Gateway instance to a room's fanout exchange.
 *
 * Creates a dedicated AMQP channel, declares the fanout exchange, and binds
 * an exclusive auto-delete queue.  All messages arriving on the queue are
 * passed to `onMessage`, except messages originating from this instance
 * (deduplication via `originInstanceId`).
 *
 * Idempotent: calling subscribeToRoom for an already-subscribed room is a
 * no-op — the existing subscription is reused.
 *
 * NOTE: This function is called fire-and-forget from messageHandler when the
 * first client joins a room on this instance.  The subscription is typically
 * established within milliseconds; the rare race where a stroke arrives before
 * the subscription is ready is acceptable for this workload (the stroke is
 * still processed locally and persisted — only cross-instance broadcast is
 * briefly delayed).
 *
 * @param {string} roomId - Room to subscribe to.
 * @param {function(object): void} onMessage - Callback invoked with the parsed
 *   payload for every message NOT published by this instance.
 * @returns {Promise<void>}
 */
async function subscribeToRoom(roomId, onMessage) {
  if (subscriptions.has(roomId)) return;

  const channel = await rabbitClient.createChannel();
  const exchange = exchangeName(roomId);

  // Fanout: every bound queue receives every published message — no routing key.
  // autoDelete: the exchange is removed when the last binding drops (room idle).
  await channel.assertExchange(exchange, 'fanout', { durable: false, autoDelete: true });

  // Mark exchange as declared on this instance so publishToRoom skips the
  // assertExchange call on the publish channel for this room.
  declaredExchanges.add(roomId);

  // Exclusive + autoDelete: queue exists only while this channel is open.
  const { queue } = await channel.assertQueue('', { exclusive: true, autoDelete: true });
  await channel.bindQueue(queue, exchange, '');

  const { consumerTag } = await channel.consume(
    queue,
    (msg) => {
      if (!msg) return; // consumer cancelled by the broker (e.g. queue deleted)

      try {
        const data = JSON.parse(msg.content.toString());

        // Skip messages this instance published — local clients were already
        // notified synchronously before publishToRoom was called.
        if (data.originInstanceId !== INSTANCE_ID) {
          const { originInstanceId: _stripped, ...cleanPayload } = data;
          onMessage(cleanPayload);
        }

        channel.ack(msg);
      } catch (err) {
        console.error(
          `[roomBroadcastBus] error processing fanout message for room=${roomId}: ${err.message}`,
        );
        channel.nack(msg, false, false);
      }
    },
    { noAck: false },
  );

  subscriptions.set(roomId, { channel, consumerTag });
  console.log(`[roomBroadcastBus] subscribed to room=${roomId} (exchange=${exchange})`);
}

/**
 * Publishes a payload to the room's fanout exchange so all other Gateway
 * instances broadcast it to their local WebSocket clients.
 *
 * The payload is augmented with `originInstanceId` to enable deduplication
 * on the consuming side.  The actual AMQP publish call is synchronous (writes
 * to an internal buffer), so this function only awaits the one-time exchange
 * declaration per room.
 *
 * Callers should use `.catch()` to handle publish failures without blocking
 * the stroke acceptance path.
 *
 * @param {string} roomId  - Room to publish to.
 * @param {object} payload - The message payload to broadcast.
 * @returns {Promise<void>}
 */
async function publishToRoom(roomId, payload) {
  const channel = rabbitClient.getPublishChannel();
  const exchange = exchangeName(roomId);

  // Declare the exchange on the publish channel once per room per instance.
  // After the first call this is a fast Set.has() check — no network I/O.
  if (!declaredExchanges.has(roomId)) {
    await channel.assertExchange(exchange, 'fanout', { durable: false, autoDelete: true });
    declaredExchanges.add(roomId);
  }

  channel.publish(
    exchange,
    '',
    Buffer.from(JSON.stringify({ ...payload, originInstanceId: INSTANCE_ID })),
  );
}

/**
 * Unsubscribes this instance from a room's fanout exchange and closes the
 * dedicated AMQP channel.
 *
 * Should be called when the last local client leaves a room.  Other Gateway
 * instances may still be subscribed — the exchange persists until they also
 * unsubscribe (autoDelete removes it when the last binding drops).
 *
 * @param {string} roomId - Room to unsubscribe from.
 * @returns {Promise<void>}
 */
async function unsubscribeFromRoom(roomId) {
  const sub = subscriptions.get(roomId);
  if (!sub) return;

  subscriptions.delete(roomId);
  declaredExchanges.delete(roomId);

  try {
    await sub.channel.cancel(sub.consumerTag);
    await sub.channel.close();
    console.log(`[roomBroadcastBus] unsubscribed from room=${roomId}`);
  } catch (err) {
    console.error(`[roomBroadcastBus] error unsubscribing from room=${roomId}: ${err.message}`);
  }
}

module.exports = { subscribeToRoom, publishToRoom, unsubscribeFromRoom, INSTANCE_ID };

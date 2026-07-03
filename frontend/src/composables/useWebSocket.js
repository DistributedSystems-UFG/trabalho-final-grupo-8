/**
 * @file useWebSocket.js
 * @description Vue 3 composable that manages a WebSocket connection lifecycle,
 * including automatic reconnection with exponential backoff and jitter.
 *
 * Usage:
 *   const { status, lastMessage, connect, send, sendRequest, disconnect } = useWebSocket();
 *   connect('ws://localhost:3000');
 *   const state = await sendRequest({ type: 'join_room', roomId, userId }, 'canvas_state');
 *
 * Reconnection strategy:
 *   - Attempts reconnect on unexpected close (not triggered by `disconnect()`).
 *   - Delay follows exponential backoff: 1s → 2s → 4s → 8s → … capped at 30s.
 *   - Each delay includes ±20% random jitter to avoid thundering herd on server restart.
 *   - Retry counter resets on successful connection.
 */

import { ref, onUnmounted } from 'vue';

/** @typedef {'connecting' | 'connected' | 'disconnected'} ConnectionStatus */

/** Minimum delay in milliseconds for the first reconnection attempt. */
const BASE_RECONNECT_DELAY_MS = 1000;

/** Maximum delay cap in milliseconds between reconnection attempts. */
const MAX_RECONNECT_DELAY_MS = 30000;

/** Jitter factor: delay is multiplied by a random value in [1-jitter, 1+jitter]. */
const RECONNECT_JITTER_FACTOR = 0.2;

/**
 * Calculates the next reconnection delay using exponential backoff with jitter.
 *
 * @param {number} attempt - The current attempt index (0-based).
 * @returns {number} Delay in milliseconds.
 */
function calculateBackoffDelay(attempt) {
  const exponential = BASE_RECONNECT_DELAY_MS * Math.pow(2, attempt);
  const capped = Math.min(exponential, MAX_RECONNECT_DELAY_MS);
  const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER_FACTOR;
  return Math.floor(capped * jitter);
}

/**
 * Composable for managing a WebSocket connection with automatic reconnection.
 *
 * @returns {{
 *   status: import('vue').Ref<ConnectionStatus>,
 *   lastMessage: import('vue').Ref<object|null>,
 *   connect: (url: string) => void,
 *   send: (payload: object) => void,
 *   sendRequest: (payload: object, responseType: string, options?: { timeoutMs?: number }) => Promise<object>,
 *   disconnect: () => void,
 * }}
 */
export function useWebSocket() {
  /** @type {import('vue').Ref<ConnectionStatus>} */
  const status = ref('disconnected');

  /** @type {import('vue').Ref<object|null>} */
  const lastMessage = ref(null);

  /** @type {WebSocket|null} */
  let socket = null;

  /** @type {string|null} */
  let serverUrl = null;

  /** @type {number} Current reconnection attempt index (0-based). */
  let reconnectAttempt = 0;

  /** @type {ReturnType<typeof setTimeout>|null} */
  let reconnectTimer = null;

  /** @type {boolean} Prevents reconnection when `disconnect()` is called intentionally. */
  let intentionalClose = false;

  /**
   * In-flight synchronous requests awaiting a correlated reply.
   * Keyed by correlationId → { resolve, reject, timer, responseType }.
   *
   * @type {Map<string, { resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>, responseType: string }>}
   */
  const pendingRequests = new Map();

  /**
   * Rejects and clears every pending request — called when the socket closes so
   * blocking callers (e.g. the join flow) fail fast instead of hanging forever.
   *
   * @param {string} reason - Human-readable rejection reason.
   */
  function rejectAllPending(reason) {
    for (const [, entry] of pendingRequests) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pendingRequests.clear();
  }

  /**
   * Clears any pending reconnection timer.
   */
  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /**
   * Schedules a reconnection attempt after an exponential backoff delay.
   */
  function scheduleReconnect() {
    if (intentionalClose) return;

    const delay = calculateBackoffDelay(reconnectAttempt);
    reconnectAttempt++;

    console.log(`[useWebSocket] reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);

    reconnectTimer = setTimeout(() => {
      if (!intentionalClose) {
        openSocket();
      }
    }, delay);
  }

  /**
   * Opens the WebSocket connection to `serverUrl`.
   * Attaches event handlers for open, message, close, and error.
   */
  function openSocket() {
    if (!serverUrl) return;

    status.value = 'connecting';
    socket = new WebSocket(serverUrl);

    socket.addEventListener('open', () => {
      status.value = 'connected';
      reconnectAttempt = 0;
      console.log('[useWebSocket] connected to', serverUrl);
    });

    socket.addEventListener('message', (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        console.warn('[useWebSocket] received non-JSON message:', event.data);
        return;
      }

      // Resolve a matching blocking request (request/reply via correlationId).
      // We still fall through to update lastMessage so existing reactive
      // watchers (e.g. PaintCanvas seeding chunkVersions from canvas_state)
      // keep working unchanged.
      if (data.correlationId && pendingRequests.has(data.correlationId)) {
        const entry = pendingRequests.get(data.correlationId);
        if (data.type === entry.responseType) {
          clearTimeout(entry.timer);
          pendingRequests.delete(data.correlationId);
          entry.resolve(data);
        } else if (data.type === 'error') {
          clearTimeout(entry.timer);
          pendingRequests.delete(data.correlationId);
          entry.reject(new Error(data.message || 'request failed'));
        }
      }

      lastMessage.value = data;
    });

    socket.addEventListener('close', (event) => {
      status.value = 'disconnected';
      console.log(`[useWebSocket] connection closed (code=${event.code}, wasClean=${event.wasClean})`);
      // Blocking callers must not hang across a disconnect.
      rejectAllPending('WebSocket disconnected before a reply was received.');
      scheduleReconnect();
    });

    socket.addEventListener('error', (event) => {
      console.error('[useWebSocket] socket error:', event);
      // The 'close' event fires immediately after 'error', so reconnect is handled there.
    });
  }

  /**
   * Initiates the WebSocket connection to the given URL.
   * Stores the URL for use in automatic reconnection attempts.
   *
   * @param {string} url - The WebSocket server URL (e.g. 'ws://localhost:3000').
   */
  function connect(url) {
    serverUrl = url;
    intentionalClose = false;
    clearReconnectTimer();
    openSocket();
  }

  /**
   * Sends a JSON-serialized payload over the WebSocket connection.
   * Silently no-ops if the socket is not open.
   *
   * @param {object} payload - The data to serialize and send.
   */
  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.warn('[useWebSocket] cannot send — socket is not open');
      return;
    }
    socket.send(JSON.stringify(payload));
  }

  /**
   * Sends a request and returns a Promise that resolves with the correlated
   * reply — a genuinely SYNCHRONOUS (blocking) remote interaction from the
   * caller's perspective, in contrast to the fire-and-forget `send`.
   *
   * A `correlationId` is generated and injected into the payload; the server
   * echoes it back on the reply, letting us match request↔response even with
   * multiple requests in flight. The Promise:
   *   - resolves when a message of type `responseType` with the same
   *     correlationId arrives;
   *   - rejects on `error` reply, on timeout, or if the socket disconnects.
   *
   * @param {object} payload - Message to send (a `type` field is expected).
   * @param {string} responseType - The `type` of the awaited reply message.
   * @param {{ timeoutMs?: number }} [options] - Optional timeout (default 5000ms).
   * @returns {Promise<object>} Resolves with the parsed reply message.
   */
  function sendRequest(payload, responseType, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('cannot send request — socket is not open'));
        return;
      }

      const correlationId = crypto.randomUUID();

      const timer = setTimeout(() => {
        pendingRequests.delete(correlationId);
        reject(new Error(`request '${payload.type}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      pendingRequests.set(correlationId, { resolve, reject, timer, responseType });
      socket.send(JSON.stringify({ ...payload, correlationId }));
    });
  }

  /**
   * Intentionally closes the WebSocket connection and prevents auto-reconnect.
   */
  function disconnect() {
    intentionalClose = true;
    clearReconnectTimer();
    rejectAllPending('WebSocket disconnected intentionally.');

    if (socket) {
      socket.close();
      socket = null;
    }

    status.value = 'disconnected';
  }

  // Ensure the socket is closed when the component using this composable is unmounted.
  onUnmounted(() => {
    disconnect();
  });

  return { status, lastMessage, connect, send, sendRequest, disconnect };
}

<template>
  <div id="aquarela-app">
    <header class="app-header">
      <h1>Aquarela<span class="accent">.io</span></h1>
      <div class="status-badge" :class="`status-badge--${status}`">
        {{ status }}
      </div>
    </header>

    <!-- Estado do join síncrono (bloqueante): o canvas só é liberado após a
         resposta canvas_state do servidor. -->
    <div v-if="joining" class="join-banner join-banner--pending">
      Entrando na sala…
    </div>
    <div v-else-if="joinError" class="join-banner join-banner--error">
      <span>Falha ao entrar na sala: {{ joinError }}</span>
      <button type="button" class="join-banner__retry" @click="joinRoom">Tentar novamente</button>
    </div>

    <PaintCanvas
      :send="send"
      :last-message="lastMessage"
      :user-id="userId"
      :room-id="roomId"
      :ready="roomReady"
    />

    <section class="event-log">
      <h2>Eventos recebidos</h2>
      <ul v-if="eventLog.length > 0">
        <li v-for="(event, index) in eventLog" :key="index" class="event-log__item">
          <span class="event-log__type">{{ event.type }}</span>
          <span class="event-log__detail">{{ event.detail }}</span>
          <span class="event-log__time">{{ event.time }}</span>
        </li>
      </ul>
      <p v-else class="event-log__empty">Aguardando eventos...</p>
    </section>
  </div>
</template>

<script>
import { defineComponent, ref, watch, onMounted } from 'vue';
import { useWebSocket } from './composables/useWebSocket.js';
import PaintCanvas from './components/PaintCanvas.vue';

/** Room every client joins on startup during Phase 1. */
const DEFAULT_ROOM_ID = 'default';

/** WebSocket server URL — falls back to same host on non-dev environments. */
const GATEWAY_WS_URL = import.meta.env.VITE_GATEWAY_WS_URL || 'ws://localhost:3000';

/** Maximum number of events displayed in the debug log. */
const MAX_EVENT_LOG_SIZE = 50;

export default defineComponent({
  name: 'App',

  components: { PaintCanvas },

  setup() {
    const { status, lastMessage, connect, send, sendRequest } = useWebSocket();

    /**
     * @type {import('vue').Ref<string>}
     * Unique user identifier generated once per session via the Web Crypto API.
     */
    const userId = ref('');

    /** @type {import('vue').Ref<boolean>} True once the blocking join resolved. */
    const roomReady = ref(false);

    /** @type {import('vue').Ref<boolean>} True while the blocking join is in flight. */
    const joining = ref(false);

    /** @type {import('vue').Ref<string|null>} Error message if the join failed. */
    const joinError = ref(null);

    /**
     * Performs the SYNCHRONOUS (blocking) join: sends `join_room` and awaits the
     * correlated `canvas_state` reply before enabling the canvas. Contrasts with
     * the fire-and-forget `stroke_event` path. Handles timeout/failure with a
     * retry affordance so the UI never hangs.
     */
    async function joinRoom() {
      joining.value = true;
      joinError.value = null;
      roomReady.value = false;

      try {
        await sendRequest(
          { type: 'join_room', roomId: DEFAULT_ROOM_ID, userId: userId.value },
          'canvas_state',
        );
        roomReady.value = true;
      } catch (err) {
        joinError.value = err.message;
        console.error('[App] blocking join failed:', err.message);
      } finally {
        joining.value = false;
      }
    }

    /**
     * @type {import('vue').Ref<Array<{type: string, detail: string, time: string}>>}
     * Circular buffer of the last MAX_EVENT_LOG_SIZE received events for debugging.
     */
    const eventLog = ref([]);

    /**
     * Appends an event entry to the debug log, trimming the oldest entry when full.
     *
     * @param {string} type - The event type string.
     * @param {string} detail - A human-readable summary of the event data.
     */
    function appendToEventLog(type, detail) {
      const time = new Date().toLocaleTimeString();
      eventLog.value.unshift({ type, detail, time });
      if (eventLog.value.length > MAX_EVENT_LOG_SIZE) {
        eventLog.value.pop();
      }
    }

    // React to every new message received from the server.
    watch(lastMessage, (message) => {
      if (!message) return;

      switch (message.type) {
        case 'room_joined':
          appendToEventLog('room_joined', `room=${message.roomId}, clients=${message.clientCount}`);
          break;
        case 'client_joined':
          appendToEventLog('client_joined', `user=${message.userId}, clients=${message.clientCount}`);
          break;
        case 'client_left':
          appendToEventLog('client_left', `user=${message.userId}, clients=${message.clientCount}`);
          break;
        case 'stroke_event':
          appendToEventLog('stroke_event', `user=${message.userId} @ (${message.x},${message.y}) chunk=${message.chunkId}`);
          break;
        case 'canvas_state': {
          const totalStrokes = message.chunks.reduce((sum, c) => sum + c.strokes.length, 0);
          appendToEventLog('canvas_state', `${message.chunks.length} chunk(s), ${totalStrokes} stroke(s) restaurados`);
          break;
        }
        case 'error':
          appendToEventLog('error', message.message);
          break;
        default:
          appendToEventLog(message.type, JSON.stringify(message));
      }
    });

    // Trigger the blocking join once the connection is established (also runs on
    // every reconnect so the canvas state is re-synced after a dropout).
    watch(status, (newStatus) => {
      if (newStatus === 'connected') {
        joinRoom();
      } else {
        // Connection lost — canvas must be re-gated until the next join resolves.
        roomReady.value = false;
      }
    });

    onMounted(() => {
      // Generate a stable user ID for this browser session using the native Web Crypto API.
      userId.value = crypto.randomUUID();
      connect(GATEWAY_WS_URL);
    });

    return {
      status, lastMessage, send, userId, roomId: DEFAULT_ROOM_ID, eventLog,
      roomReady, joining, joinError, joinRoom,
    };
  },
});
</script>

<style>
/* ── Design tokens: tema escuro preto/vermelho ─────────────────
   Introduzido no Redesign. O canvas de desenho permanece BRANCO
   (--canvas-bg) para preservar o comportamento do blending. */
:root {
  --bg: #0d0d0f;          /* fundo quase preto da página */
  --surface: #1a1a1f;     /* toolbar, cards, log */
  --surface-2: #24242b;   /* elementos elevados / hover */
  --border: #33333d;      /* bordas sutis */

  --text: #f2f2f5;        /* texto principal */
  --text-muted: #9a9aa5;  /* texto secundário */

  --accent: #e11d2a;         /* vermelho de destaque */
  --accent-hover: #b3151f;   /* vermelho pressionado */
  --accent-soft: rgba(225, 29, 42, 0.15); /* realces translúcidos */

  --canvas-bg: #ffffff;   /* o chunk de desenho permanece branco */

  --radius: 10px;
  --shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
}

body {
  margin: 0;
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
}

#aquarela-app {
  max-width: 860px;
  margin: 0 auto;
  padding: 2rem 1rem;
}

.app-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1rem;
}

.app-header h1 {
  margin: 0;
  font-size: 2.2rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--text);
}

/* Destaque em vermelho no sufixo ".io" via <span>. */
.app-header h1 .accent {
  color: var(--accent);
}

.status-badge {
  padding: 0.28rem 0.8rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

/* Ponto luminoso antes do texto para reforçar o estado. */
.status-badge::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

.status-badge--connecting  { color: #e0a83a; border-color: #4a3a1a; }
.status-badge--connected   { color: #3ec26b; border-color: #1c4028; }
.status-badge--disconnected { color: var(--accent); border-color: #4a1a1e; }

.phase-note {
  color: var(--text-muted);
  margin-bottom: 1.5rem;
}

.join-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.6rem 1rem;
  margin-bottom: 0.75rem;
  border-radius: var(--radius);
  font-size: 0.9rem;
  font-weight: 600;
  border: 1px solid var(--border);
  background: var(--surface);
}

.join-banner--pending { color: #e0a83a; border-color: #4a3a1a; }
.join-banner--error   { color: var(--accent); border-color: #4a1a1e; }

.join-banner__retry {
  border: none;
  border-radius: 6px;
  padding: 0.35rem 0.85rem;
  background: var(--accent);
  color: #fff;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s ease;
}

.join-banner__retry:hover { background: var(--accent-hover); }

.event-log {
  margin-top: 1.5rem;
}

.event-log h2 {
  font-size: 0.95rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 0.5rem;
}

.event-log ul {
  list-style: none;
  padding: 0;
  margin: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.event-log__item {
  display: flex;
  gap: 0.75rem;
  padding: 0.4rem 0.85rem;
  font-size: 0.8rem;
  font-family: 'SFMono-Regular', Consolas, monospace;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.event-log__item:last-child { border-bottom: none; }

.event-log__type   { color: var(--accent); min-width: 130px; }
.event-log__detail { color: var(--text); flex: 1; }
.event-log__time   { color: var(--text-muted); white-space: nowrap; }

.event-log__empty  { color: var(--text-muted); font-size: 0.875rem; }
</style>

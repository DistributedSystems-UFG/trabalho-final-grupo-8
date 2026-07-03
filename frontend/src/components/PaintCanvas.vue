<template>
  <div class="paint-canvas-wrapper">
    <!-- Toolbar: paleta própria + tamanho + opacidade + ferramenta -->
    <div class="paint-controls">
      <!-- ── Cor ─────────────────────────────────────────── -->
      <div class="paint-controls__group">
        <span class="paint-controls__group-label">Cor</span>
        <GodePalette v-model="selectedColor" />
      </div>

      <span class="paint-controls__sep" aria-hidden="true" />

      <!-- ── Pincel ──────────────────────────────────────── -->
      <div class="paint-controls__group">
        <span class="paint-controls__group-label">Pincel</span>
        <label class="paint-controls__field">
          <span class="paint-controls__field-name">Tamanho</span>
          <input
            type="range"
            min="2"
            max="32"
            v-model.number="brushSize"
            class="paint-controls__slider"
            aria-label="Tamanho do pincel"
          />
          <span class="paint-controls__field-value">{{ brushSize }}px</span>
        </label>
        <label class="paint-controls__field">
          <span class="paint-controls__field-name">Opacidade</span>
          <input
            type="range"
            min="5"
            max="100"
            v-model.number="opacityPercent"
            class="paint-controls__slider"
            aria-label="Opacidade do pincel"
          />
          <span class="paint-controls__field-value">{{ opacityPercent }}%</span>
        </label>
      </div>

      <span class="paint-controls__sep" aria-hidden="true" />

      <!-- ── Ferramenta ──────────────────────────────────── -->
      <div class="paint-controls__group">
        <span class="paint-controls__group-label">Ferramenta</span>
        <div class="paint-controls__tools" role="group" aria-label="Ferramenta ativa">
          <button
            type="button"
            class="paint-controls__tool"
            :class="{ 'paint-controls__tool--active': tool === 'brush' }"
            :aria-pressed="tool === 'brush'"
            @click="tool = 'brush'"
          >
            🖌 Pincel
          </button>
          <button
            type="button"
            class="paint-controls__tool"
            :class="{ 'paint-controls__tool--active': tool === 'eraser' }"
            :aria-pressed="tool === 'eraser'"
            @click="tool = 'eraser'"
          >
            🩹 Borracha
          </button>
        </div>
      </div>
    </div>

    <!--
      Canvas element — CSS width is 100% so it fills the container.
      The logical pixel dimensions (canvas.width / canvas.height) are set by
      useCanvas.initCanvas() and kept in sync via ResizeObserver.
    -->
    <canvas
      ref="canvasRef"
      class="paint-canvas"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
      @mouseleave="onMouseLeave"
      @touchstart.prevent="onTouchStart"
      @touchmove.prevent="onTouchMove"
      @touchend.prevent="onTouchEnd"
    />
  </div>
</template>

<script>
import { defineComponent, ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue';
import { useCanvas } from '../composables/useCanvas.js';
import GodePalette from './GodePalette.vue';

/** Initial pigment colour — Azul Ultramar, the first pan in the godê. */
const INITIAL_COLOR = '#120A8F';

/** Default brush diameter in pixels. */
const DEFAULT_BRUSH_SIZE = 8;

/** Default stroke opacity (0–1). Matches the previous hard-coded watercolour look. */
const DEFAULT_OPACITY = 0.72;

export default defineComponent({
  name: 'PaintCanvas',

  components: { GodePalette },

  props: {
    /**
     * Function to send a message payload over the active WebSocket connection.
     * Provided by the parent (App.vue) from the useWebSocket composable.
     * @type {(payload: object) => void}
     */
    send: {
      type: Function,
      required: true,
    },

    /**
     * Reactive ref or plain object containing the last message received from
     * the WebSocket server. The component watches this for incoming stroke_event
     * messages from other users.
     * @type {object|null}
     */
    lastMessage: {
      type: Object,
      default: null,
    },

    /**
     * Unique identifier for the local user, generated once per browser session
     * using the Web Crypto API. Used to filter out echoed strokes from the server.
     * @type {string}
     */
    userId: {
      type: String,
      required: true,
    },

    /**
     * Room identifier for the collaborative session this canvas belongs to.
     * Included in every outgoing stroke_event payload.
     * @type {string}
     */
    roomId: {
      type: String,
      required: true,
    },

    /**
     * Whether the blocking join has completed and the canvas may be painted.
     * While false (join_room request still pending), stroke initiation is
     * suppressed so the very first stroke always carries correct chunk versions.
     * @type {boolean}
     */
    ready: {
      type: Boolean,
      default: true,
    },
  },

  setup(props) {
    const {
      canvasRef,
      isDrawing,
      initCanvas,
      drawStroke,
      drawInterpolatedStroke,
      getContext,
      startStroke,
      continueStroke,
      endStroke,
      calculateChunkId,
      destroyCanvas,
    } = useCanvas();

    /** @type {import('vue').Ref<string>} Currently selected pigment colour from the godê. */
    const selectedColor = ref(INITIAL_COLOR);

    /**
     * Per-chunk OCC (Optimistic Concurrency Control) version map.
     * Keys are chunkId strings (e.g. "0_0"); values are the last version the
     * client received from the server for that chunk.
     *
     * Seeded from `canvas_state` on join so the very first stroke always
     * carries the correct version.  Updated on every `stroke_ack` (accepted
     * own stroke) and `conflict_event` (rejected stroke — server sends the
     * authoritative version).  Also updated when a `stroke_event` from
     * another user arrives carrying a newer version.
     *
     * @type {Map<string, number>}
     */
    const chunkVersions = reactive(new Map());

    /** @type {import('vue').Ref<number>} Currently selected brush diameter in pixels. */
    const brushSize = ref(DEFAULT_BRUSH_SIZE);

    /** @type {import('vue').Ref<number>} Stroke opacity in [0, 1]. */
    const opacity = ref(DEFAULT_OPACITY);

    /**
     * Opacity exposed to the slider as an integer percentage (5–100), bridging
     * the 0–1 float stored in `opacity`.
     * @type {import('vue').WritableComputedRef<number>}
     */
    const opacityPercent = computed({
      get: () => Math.round(opacity.value * 100),
      set: (pct) => { opacity.value = pct / 100; },
    });

    /** @type {import('vue').Ref<'brush'|'eraser'>} Active tool. */
    const tool = ref('brush');

    /** @type {import('vue').Ref<{x:number,y:number}|null>} Last committed local stroke point. */
    const lastLocalPoint = ref(null);

    /** @type {import('vue').Ref<{x:number,y:number}|null>} Pending point captured from move events. */
    const pendingLocalPoint = ref(null);

    /** @type {number|null} Active RAF id for local stroke emission loop. */
    let localStrokeFrameId = null;

    /** @type {import('vue').Ref<object[]>} Queue of incoming websocket messages. */
    const messageQueue = ref([]);

    /** @type {number|null} Active RAF id for websocket message draining loop. */
    let messageFrameId = null;

    /**
     * Strokes from a canvas_state replay waiting to be drawn in batches.
     * Populated when a canvas_state message arrives; drained N strokes per frame
     * in the RAF tick so the main thread is never blocked for long tasks.
     *
     * @type {Array<{x:number,y:number,color:string,brushSize:number,opacity?:number,eraser?:boolean}>}
     */
    let pendingReplayStrokes = [];

    /** Maximum strokes drawn per animation frame during canvas_state replay. */
    const REPLAY_BATCH_SIZE = 50;

    // -------------------------------------------------------------------------
    // Coordinate helpers
    // -------------------------------------------------------------------------

    /**
     * Extracts canvas-relative pixel coordinates from a MouseEvent.
     * Uses getBoundingClientRect to correctly account for CSS scaling and layout.
     *
     * @param {MouseEvent} event
     * @returns {{ x: number, y: number }}
     */
    function getMouseCoords(event) {
      const rect = canvasRef.value.getBoundingClientRect();
      return {
        x: Math.round(event.clientX - rect.left),
        y: Math.round(event.clientY - rect.top),
      };
    }

    /**
     * Extracts canvas-relative pixel coordinates from a Touch object.
     *
     * @param {Touch} touch - A single touch point from a TouchEvent.
     * @returns {{ x: number, y: number }}
     */
    function getTouchCoords(touch) {
      const rect = canvasRef.value.getBoundingClientRect();
      return {
        x: Math.round(touch.clientX - rect.left),
        y: Math.round(touch.clientY - rect.top),
      };
    }

    // -------------------------------------------------------------------------
    // Core paint action
    // -------------------------------------------------------------------------

    /**
     * Renders a brush stamp locally and broadcasts a stroke_event to the gateway.
     *
     * Optimistic rendering decision: the stroke is drawn on the local canvas
     * immediately, without waiting for the server echo. This gives instant visual
     * feedback to the painter and is consistent with the Optimistic Locking strategy
     * introduced in Phase 5. Remote echoes of the local user's own strokes are
     * suppressed in the incoming message watcher to prevent double-drawing.
     *
     * Chunk partitioning decision: each payload includes a `chunkId` computed from
     * the pixel position. The gateway and worker use this field to route simulation
     * jobs and apply per-chunk version locks (Phase 5).
     *
     * @param {number} x - Canvas X coordinate.
     * @param {number} y - Canvas Y coordinate.
     */
    function emitAndDrawStroke(x, y) {
      const chunkId = calculateChunkId(x, y);
      const version = chunkVersions.get(chunkId) ?? 0;

      // Increment the local version BEFORE sending so that the next stroke
      // fired by a rapid mousemove (before any stroke_ack arrives) carries a
      // unique, incrementing version rather than the same stale value.
      // Without this, rapid painting produces a burst of strokes all with the
      // same version — only the first is accepted by the Gateway; the rest
      // generate spurious conflict_events for a single-user session.
      //
      // If the server rejects this stroke (genuine multi-user conflict), the
      // conflict_event handler below will overwrite chunkVersions with the
      // authoritative server version, correcting any drift.
      chunkVersions.set(chunkId, version + 1);

      const isEraser = tool.value === 'eraser';

      /** @type {{ type: string, roomId: string, userId: string, x: number, y: number, color: string, brushSize: number, opacity: number, eraser: boolean, timestamp: number, chunkId: string, version: number }} */
      const payload = {
        type: 'stroke_event',
        roomId: props.roomId,
        userId: props.userId,
        x,
        y,
        color: selectedColor.value,
        brushSize: brushSize.value,
        opacity: opacity.value,
        eraser: isEraser,
        timestamp: Date.now(),
        chunkId,
        version,
      };

      // Optimistic local render — immediate visual feedback, no round-trip.
      if (lastLocalPoint.value) {
        drawInterpolatedStroke(
          lastLocalPoint.value.x,
          lastLocalPoint.value.y,
          x,
          y,
          selectedColor.value,
          brushSize.value,
          opacity.value,
          isEraser
        );
      } else {
        drawStroke(x, y, selectedColor.value, brushSize.value, opacity.value, isEraser);
      }
      lastLocalPoint.value = { x, y };

      props.send(payload);
    }

    /**
     * Starts the RAF loop that flushes the latest pending move point at most
     * once per frame.
     */
    function startLocalStrokeLoop() {
      if (localStrokeFrameId !== null) return;

      const tick = () => {
        if (pendingLocalPoint.value) {
          const point = pendingLocalPoint.value;
          pendingLocalPoint.value = null;
          emitAndDrawStroke(point.x, point.y);
        }

        if (isDrawing.value) {
          localStrokeFrameId = requestAnimationFrame(tick);
          return;
        }

        localStrokeFrameId = null;
      };

      localStrokeFrameId = requestAnimationFrame(tick);
    }

    /**
     * Stops the RAF loop used for local stroke emission.
     */
    function stopLocalStrokeLoop() {
      if (localStrokeFrameId !== null) {
        cancelAnimationFrame(localStrokeFrameId);
        localStrokeFrameId = null;
      }
      pendingLocalPoint.value = null;
      lastLocalPoint.value = null;
    }

    // -------------------------------------------------------------------------
    // Mouse event handlers
    // -------------------------------------------------------------------------

    /**
     * Initiates a new stroke on mouse button press.
     * @param {MouseEvent} event
     */
    function onMouseDown(event) {
      // Gate: ignore painting until the blocking join has restored canvas state.
      if (!props.ready) return;
      startStroke();
      pendingLocalPoint.value = null;
      lastLocalPoint.value = null;
      const { x, y } = getMouseCoords(event);
      emitAndDrawStroke(x, y);
      startLocalStrokeLoop();
    }

    /**
     * Continues the active stroke while the mouse moves over the canvas.
     * Guards against spurious moves when no button is pressed.
     * @param {MouseEvent} event
     */
    function onMouseMove(event) {
      if (!isDrawing.value) return;
      continueStroke();
      const { x, y } = getMouseCoords(event);
      pendingLocalPoint.value = { x, y };
    }

    /**
     * Terminates the stroke on mouse button release.
     */
    function onMouseUp() {
      endStroke();
      stopLocalStrokeLoop();
    }

    /**
     * Terminates the stroke when the cursor exits the canvas boundary.
     * Prevents a "sticky brush" where the stroke continues invisibly off-canvas.
     */
    function onMouseLeave() {
      endStroke();
      stopLocalStrokeLoop();
    }

    // -------------------------------------------------------------------------
    // Touch event handlers
    // -------------------------------------------------------------------------

    /**
     * Initiates a stroke from the first touch contact point.
     * The .prevent modifier on the template suppresses native scroll behaviour
     * so painting does not accidentally scroll the page on mobile.
     * @param {TouchEvent} event
     */
    function onTouchStart(event) {
      // Gate: ignore painting until the blocking join has restored canvas state.
      if (!props.ready) return;
      startStroke();
      pendingLocalPoint.value = null;
      lastLocalPoint.value = null;
      const { x, y } = getTouchCoords(event.touches[0]);
      emitAndDrawStroke(x, y);
      startLocalStrokeLoop();
    }

    /**
     * Continues the stroke as the finger moves across the canvas.
     * @param {TouchEvent} event
     */
    function onTouchMove(event) {
      if (!isDrawing.value) return;
      continueStroke();
      const { x, y } = getTouchCoords(event.touches[0]);
      pendingLocalPoint.value = { x, y };
    }

    /**
     * Terminates the stroke when the finger is lifted.
     */
    function onTouchEnd() {
      endStroke();
      stopLocalStrokeLoop();
    }

    // -------------------------------------------------------------------------
    // Simulated pixel rendering (fluid diffusion results)
    // -------------------------------------------------------------------------

    /**
     * Renders diffused pixels returned by the Worker onto the canvas.
     *
     * Called when a ``pixel_update`` WebSocket message arrives.  Each pixel
     * carries canvas-absolute (x, y) coordinates and pre-computed RGBA values
     * from the NumPy diffusion grid.  They are painted as 1×1 squares directly
     * on the 2D context without affecting the user's drawing state.
     *
     * Design decision — visual-only, no OCC interaction:
     *  The fluid diffusion result is a post-processing visual effect; it does
     *  not represent a new user stroke and therefore must NOT increment the
     *  local chunkVersions map.  Doing so would cause the next real stroke from
     *  the user to carry a version that the server has never seen, triggering
     *  a spurious conflict_event.
     *
     * @param {Array<{ x: number, y: number, r: number, g: number, b: number, a: number }>} pixels
     *   Array of diffused pixel descriptors in canvas-absolute coordinates.
     */
    function applySimulatedPixels(pixels) {
      const ctx2d = getContext();
      const canvas = canvasRef.value;
      if (!ctx2d || !canvas || !Array.isArray(pixels) || pixels.length === 0) return;

      const validPixels = pixels.filter((pixel) => (
        Number.isFinite(pixel.x)
        && Number.isFinite(pixel.y)
        && pixel.x >= 0
        && pixel.y >= 0
        && pixel.x < canvas.width
        && pixel.y < canvas.height
        // Discard near-transparent pixels: diffusion alpha-decay can produce
        // pixels with a ≈ 0 that would overwrite user strokes with blank pixels,
        // creating visible white blocks on the canvas.
        && pixel.a >= 5
      ));

      if (validPixels.length === 0) return;

      let minX = validPixels[0].x;
      let minY = validPixels[0].y;
      let maxX = validPixels[0].x;
      let maxY = validPixels[0].y;

      for (const pixel of validPixels) {
        if (pixel.x < minX) minX = pixel.x;
        if (pixel.y < minY) minY = pixel.y;
        if (pixel.x > maxX) maxX = pixel.x;
        if (pixel.y > maxY) maxY = pixel.y;
      }

      const startX = Math.floor(minX);
      const startY = Math.floor(minY);
      const width = Math.ceil(maxX) - startX + 1;
      const height = Math.ceil(maxY) - startY + 1;
      if (width <= 0 || height <= 0) return;

      const imageData = ctx2d.getImageData(startX, startY, width, height);
      const buffer = imageData.data;

      for (const pixel of validPixels) {
        const px = Math.round(pixel.x) - startX;
        const py = Math.round(pixel.y) - startY;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;

        const index = (py * width + px) * 4;
        buffer[index] = pixel.r;
        buffer[index + 1] = pixel.g;
        buffer[index + 2] = pixel.b;
        buffer[index + 3] = pixel.a;
      }

      ctx2d.putImageData(imageData, startX, startY);
    }

    /**
     * Processes one incoming websocket message.
     *
     * @param {object} message
     */
    function processIncomingMessage(message) {
      if (!message) return;

      if (message.type === 'stroke_event') {
        // Skip own echoes — already rendered optimistically on emit.
        if (message.userId === props.userId) return;
        drawStroke(
          message.x,
          message.y,
          message.color,
          message.brushSize,
          message.opacity ?? 1,
          message.eraser ?? false
        );
        // Advance the local version map so our next stroke on the same chunk
        // carries a version that accounts for the remote stroke just applied.
        if (message.chunkId && typeof message.version === 'number') {
          chunkVersions.set(message.chunkId, message.version);
        }
        return;
      }

      if (message.type === 'canvas_state') {
        // Seed the OCC version map immediately so the user can start painting
        // while the historical strokes are still being replayed in the background.
        for (const chunk of message.chunks) {
          if (typeof chunk.version === 'number') {
            chunkVersions.set(chunk.chunkId, chunk.version);
          }
        }

        // Instead of replaying all strokes synchronously (which blocks the main
        // thread for seconds on large canvases), flatten them into a queue that
        // is drained REPLAY_BATCH_SIZE strokes per animation frame.
        // Ordering is preserved because strokes were appended sequentially
        // to the JSONB array in the database.
        for (const chunk of message.chunks) {
          for (const stroke of chunk.strokes) {
            pendingReplayStrokes.push(stroke);
          }
        }
        return;
      }

      if (message.type === 'stroke_ack') {
        // The server accepted our last stroke on this chunk and has bumped
        // the version.  Store the new authoritative version so the next stroke
        // on the same chunk carries the correct OCC payload.
        if (message.chunkId && typeof message.newVersion === 'number') {
          chunkVersions.set(message.chunkId, message.newVersion);
        }
        return;
      }

      if (message.type === 'conflict_event') {
        // Our stroke was rejected because another user painted the same chunk
        // after our last sync.  Update the local version to the server's
        // authoritative value so the next stroke attempt will be accepted.
        // The optimistically rendered stroke remains on screen — no auto-revert.
        console.warn(
          `[canvas] conflict on chunk=${message.chunkId}: ` +
          `our version=${message.rejectedVersion} was stale, ` +
          `server version=${message.currentVersion}. Re-paint to apply your change.`
        );
        if (message.chunkId && typeof message.currentVersion === 'number') {
          chunkVersions.set(message.chunkId, message.currentVersion);
        }
        return;
      }

      if (message.type === 'pixel_update') {
        // The Worker has diffused the pigment for a chunk and returned the
        // changed pixels.  Render them directly on the canvas without affecting
        // the local user's drawing state or OCC version map.
        // pixel_update is a visual-only event and does NOT participate in OCC.
        applySimulatedPixels(message.pixels);
      }
    }

    /**
     * Starts the RAF loop that drains the websocket message queue once per frame.
     */
    function startMessageLoop() {
      if (messageFrameId !== null) return;

      const tick = () => {
        // Drain a bounded slice of the canvas_state replay queue first.
        // Processing a fixed number of strokes per frame keeps the main thread
        // responsive during the initial state replay on room join.
        if (pendingReplayStrokes.length > 0) {
          const replayBatch = pendingReplayStrokes.splice(0, REPLAY_BATCH_SIZE);
          for (const stroke of replayBatch) {
            drawStroke(
              stroke.x,
              stroke.y,
              stroke.color,
              stroke.brushSize,
              stroke.opacity ?? 1,
              stroke.eraser ?? false
            );
          }
        }

        if (messageQueue.value.length > 0) {
          const batch = messageQueue.value.splice(0, messageQueue.value.length);
          for (const message of batch) {
            processIncomingMessage(message);
          }
        }
        messageFrameId = requestAnimationFrame(tick);
      };

      messageFrameId = requestAnimationFrame(tick);
    }

    /**
     * Stops the RAF loop that drains websocket messages.
     */
    function stopMessageLoop() {
      if (messageFrameId !== null) {
        cancelAnimationFrame(messageFrameId);
        messageFrameId = null;
      }
      messageQueue.value = [];
      pendingReplayStrokes = [];
    }

    // -------------------------------------------------------------------------
    // Remote stroke rendering
    // -------------------------------------------------------------------------

    /**
     * Watches for incoming WebSocket messages and renders strokes from other users.
     *
     * Filtering decision: strokes originating from the local userId are skipped
     * because they were already rendered optimistically in emitAndDrawStroke().
     * Rendering them again would produce duplicated, darker marks on the canvas.
     * The gateway broadcasts stroke_event to all room members EXCLUDING the sender,
     * so only other users' strokes arrive here.
     *
     * canvas_state handling: when a client first joins a room it receives a
     * `canvas_state` message containing all persisted strokes grouped by chunk.
     * Each stroke is re-played through drawStroke() to restore the canvas to its
     * last saved state.  The `version` field per chunk seeds `chunkVersions` so
     * the first outgoing stroke carries the correct OCC version.
     *
     * stroke_ack handling: the server sends this back to the stroke author after
     * accepting a stroke.  The new authoritative version is stored in `chunkVersions`
     * so subsequent strokes on the same chunk carry the correct version.
     *
     * conflict_event handling: the server sends this when the client's version is
     * stale.  The authoritative version is stored so the next stroke attempt uses
     * the correct baseline.  The optimistically rendered stroke remains visible —
     * the user can simply re-paint the area if desired (no auto-retry by design,
     * keeping Phase 5 scope clean).
     */
    watch(
      () => props.lastMessage,
      (message) => {
        if (!message) return;
        messageQueue.value.push(message);
      }
    );

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    onMounted(() => {
      initCanvas(canvasRef.value);
      startMessageLoop();
    });

    onUnmounted(() => {
      stopLocalStrokeLoop();
      stopMessageLoop();
      destroyCanvas();
    });

    return {
      canvasRef,
      selectedColor,
      brushSize,
      opacityPercent,
      tool,
      onMouseDown,
      onMouseMove,
      onMouseUp,
      onMouseLeave,
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      applySimulatedPixels,
    };
  },
});
</script>

<style scoped>
.paint-canvas-wrapper {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  margin-bottom: 1.5rem;
}

/* ── Toolbar ───────────────────────────────────────────────── */
.paint-controls {
  display: flex;
  align-items: stretch;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 0.85rem 1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.paint-controls__group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  justify-content: center;
}

.paint-controls__group-label {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-muted);
}

.paint-controls__sep {
  width: 1px;
  align-self: stretch;
  background: var(--border);
}

/* ── Sliders (tamanho / opacidade) ─────────────────────────── */
.paint-controls__field {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  color: var(--text);
  white-space: nowrap;
}

.paint-controls__field-name {
  min-width: 4.5rem;
  color: var(--text-muted);
}

.paint-controls__slider {
  width: 110px;
  accent-color: var(--accent);
  cursor: pointer;
}

.paint-controls__field-value {
  font-variant-numeric: tabular-nums;
  min-width: 2.8rem;
  text-align: right;
  color: var(--text);
  font-size: 0.78rem;
}

/* ── Botões de ferramenta ──────────────────────────────────── */
.paint-controls__tools {
  display: flex;
  gap: 0.4rem;
}

.paint-controls__tool {
  padding: 0.4rem 0.75rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
}

.paint-controls__tool:hover {
  color: var(--text);
  border-color: var(--accent);
}

.paint-controls__tool--active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--text);
}

/* ── Canvas ────────────────────────────────────────────────── */
.paint-canvas {
  display: block;
  width: 100%;
  height: 600px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--canvas-bg); /* branco — o chunk de desenho */
  box-shadow: var(--shadow);
  cursor: crosshair;
  touch-action: none; /* prevents browser handling touch gestures over the canvas */
}
</style>

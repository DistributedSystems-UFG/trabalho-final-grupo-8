/**
 * @file useCanvas.js
 * @description Vue 3 composable that encapsulates all HTML5 Canvas drawing logic,
 * including stroke rendering, chunk partitioning, and responsive resize handling.
 *
 * SRP Decision: This composable is deliberately isolated from WebSocket and Vue props.
 * It only knows about canvas geometry and drawing — all network and room concerns
 * live in PaintCanvas.vue and useWebSocket.js respectively.
 *
 * Usage:
 *   const { canvasRef, isDrawing, initCanvas, drawStroke, ... } = useCanvas();
 *   onMounted(() => initCanvas(canvasRef.value));
 */

import { ref } from 'vue';

/** Fixed canvas height in logical pixels. Width is responsive via ResizeObserver. */
const CANVAS_HEIGHT_PX = 600;

/**
 * Number of divisions along each axis for the chunk partition grid.
 * An 8×8 grid produces 64 chunks, each identified by "col_row".
 *
 * Chunk partitioning decision: partitioning the canvas into chunks allows
 * the backend to apply optimistic locking per-chunk (Phase 5) rather than
 * per-pixel, reducing lock contention while keeping conflict scope small.
 */
const CHUNK_GRID_SIZE = 8;

/**
 * Composable for managing an HTML5 Canvas element: drawing, resize, and chunk math.
 *
 * @returns {{
 *   canvasRef: import('vue').Ref<HTMLCanvasElement|null>,
 *   isDrawing: import('vue').Ref<boolean>,
 *   initCanvas: (el: HTMLCanvasElement) => void,
 *   drawStroke: (x: number, y: number, color: string, brushSize: number, opacity?: number, eraser?: boolean) => void,
 *   drawInterpolatedStroke: (x0: number, y0: number, x1: number, y1: number, color: string, brushSize: number, opacity?: number, eraser?: boolean) => void,
 *   getContext: () => CanvasRenderingContext2D|null,
 *   startStroke: () => void,
 *   continueStroke: () => void,
 *   endStroke: () => void,
 *   calculateChunkId: (x: number, y: number) => string,
 *   destroyCanvas: () => void,
 * }}
 */
export function useCanvas() {
  /** @type {import('vue').Ref<HTMLCanvasElement|null>} Template ref target for the canvas element. */
  const canvasRef = ref(null);

  /** @type {import('vue').Ref<boolean>} Whether a stroke is currently in progress. */
  const isDrawing = ref(false);

  /** @type {CanvasRenderingContext2D|null} 2D rendering context, set during initCanvas. */
  let ctx = null;

  /** @type {ResizeObserver|null} Observes the canvas container to keep canvas width in sync. */
  let resizeObserver = null;

  // ---------------------------------------------------------------------------
  // Initialisation & resize
  // ---------------------------------------------------------------------------

  /**
   * Sets the logical pixel dimensions of the canvas element to match the
   * container's current width and the fixed CANVAS_HEIGHT_PX.
   *
   * Note: changing canvas.width/height clears the bitmap. This is acceptable
   * on resize because the persistent state lives in the database (Phase 3);
   * the server will push the full chunk state to reconnected clients.
   *
   * @param {HTMLCanvasElement} el - The canvas DOM element.
   */
  function resizeCanvas(el) {
    const containerWidth = el.parentElement
      ? el.parentElement.clientWidth
      : el.clientWidth;

    const newWidth = containerWidth || 800;
    const newHeight = CANVAS_HEIGHT_PX;

    // Bail out when dimensions are already correct.
    // Setting canvas.width/height always clears the bitmap (HTML5 spec), so
    // assigning the same value would erase all painted content on every
    // incidental layout change (sidebar toggle, scrollbar, etc.).
    if (el.width === newWidth && el.height === newHeight) return;

    // Snapshot the current bitmap before the resize clears it.
    const resizeCtx = el.getContext('2d');
    let snapshot = null;
    if (resizeCtx && el.width > 0 && el.height > 0) {
      try {
        snapshot = resizeCtx.getImageData(0, 0, el.width, el.height);
      } catch {
        // getImageData can throw on cross-origin canvases; treat as no snapshot.
      }
    }

    el.width = newWidth;
    el.height = newHeight;

    // Keep an opaque light paper base so multiply blending behaves predictably.
    if (resizeCtx) {
      resizeCtx.fillStyle = '#ffffff';
      resizeCtx.fillRect(0, 0, el.width, el.height);

      // Restore the previous canvas content on top of the white base.
      if (snapshot) {
        resizeCtx.putImageData(snapshot, 0, 0);
      }
    }
  }

  /**
   * Initialises the canvas: acquires the 2D context, sizes the element, and
   * attaches a ResizeObserver so width stays in sync with the container.
   *
   * @param {HTMLCanvasElement} el - The canvas DOM element to initialise.
   */
  function initCanvas(el) {
    if (!el) return;

    ctx = el.getContext('2d');
    resizeCanvas(el);

    // Observe the parent container rather than the canvas itself, because the
    // canvas CSS width is set to 100% and the logical size is driven by JS.
    const target = el.parentElement || el;
    resizeObserver = new ResizeObserver(() => resizeCanvas(el));
    resizeObserver.observe(target);
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  /** Alpha do centro do carimbo de pincel com opacidade máxima (opacity=1). */
  const CORE_ALPHA = 0.72;
  /** Alpha da borda (stop 0.7) do carimbo com opacidade máxima. */
  const EDGE_ALPHA = 0.30;

  /**
   * Draws a filled circle (one brush stamp) at the given canvas coordinates.
   * This function is the single rendering primitive for both local (optimistic)
   * and remote (received via WebSocket) strokes.
   *
   * @param {number} x - X coordinate in canvas pixels.
   * @param {number} y - Y coordinate in canvas pixels.
   * @param {string} color - CSS color string (e.g., '#e63946').
   * @param {number} brushSize - Brush diameter in pixels.
   * @param {number} [opacity=1] - Stroke intensity multiplier in [0, 1]. Scales
   *   the soft watercolour alpha stops so the same primitive covers translucent
   *   glazes and near-opaque strokes.
   * @param {boolean} [eraser=false] - When true the stamp removes pigment
   *   (destination-out) instead of adding it (multiply), revealing the white
   *   canvas underneath while keeping the soft brush edge.
   */
  function drawStroke(x, y, color, brushSize, opacity = 1, eraser = false) {
    if (!ctx) return;

    const radius = Math.max(1, brushSize / 2);
    const clampedOpacity = Math.min(1, Math.max(0, opacity));
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);

    if (eraser) {
      // Eraser: alpha of the gradient controls how much pigment is cleared.
      // The colour is irrelevant under destination-out — only alpha matters.
      gradient.addColorStop(0, `rgba(0, 0, 0, ${CORE_ALPHA * clampedOpacity})`);
      gradient.addColorStop(0.7, `rgba(0, 0, 0, ${EDGE_ALPHA * clampedOpacity})`);
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    } else {
      const { r, g, b } = hexToRgb(color);
      gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${CORE_ALPHA * clampedOpacity})`);
      gradient.addColorStop(0.7, `rgba(${r}, ${g}, ${b}, ${EDGE_ALPHA * clampedOpacity})`);
      gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    }

    const previousComposite = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = eraser ? 'destination-out' : 'multiply';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.globalCompositeOperation = previousComposite;
  }

  /**
   * Draws a continuous stroke segment between two points by stamping the brush
   * at regular intervals along the line.
   *
   * @param {number} x0 - Start X coordinate.
   * @param {number} y0 - Start Y coordinate.
   * @param {number} x1 - End X coordinate.
   * @param {number} y1 - End Y coordinate.
   * @param {string} color - CSS color string.
   * @param {number} brushSize - Brush diameter in pixels.
   * @param {number} [opacity=1] - Stroke intensity multiplier in [0, 1].
   * @param {boolean} [eraser=false] - Whether this segment erases pigment.
   */
  function drawInterpolatedStroke(x0, y0, x1, y1, color, brushSize, opacity = 1, eraser = false) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const distance = Math.hypot(dx, dy);
    const step = Math.max(1, brushSize / 3);
    const steps = Math.max(1, Math.ceil(distance / step));

    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      drawStroke(x0 + dx * t, y0 + dy * t, color, brushSize, opacity, eraser);
    }
  }

  /**
   * Returns the current 2D rendering context.
   *
   * @returns {CanvasRenderingContext2D|null}
   */
  function getContext() {
    return ctx;
  }

  // ---------------------------------------------------------------------------
  // Stroke state management (SRP: only the draw state flag lives here)
  // ---------------------------------------------------------------------------

  /**
   * Marks the beginning of a new drawing stroke.
   * Call this on mousedown / touchstart.
   */
  function startStroke() {
    isDrawing.value = true;
  }

  /**
   * Acknowledges a continuation point within the active stroke.
   * The caller (PaintCanvas.vue) is responsible for guarding this with isDrawing.
   */
  function continueStroke() {
    // Intentionally minimal — stroke state transitions are binary (drawing / not drawing).
    // Interpolation between points is a future enhancement (Phase 6 fluid simulation).
  }

  /**
   * Ends the current drawing stroke.
   * Call this on mouseup / mouseleave / touchend.
   */
  function endStroke() {
    isDrawing.value = false;
  }

  // ---------------------------------------------------------------------------
  // Chunk partitioning
  // ---------------------------------------------------------------------------

  /**
   * Calculates the chunk identifier for a given canvas coordinate.
   *
   * The canvas is partitioned into a CHUNK_GRID_SIZE × CHUNK_GRID_SIZE grid.
   * Each cell is identified by its zero-based column and row indices, formatted
   * as the string "col_row" (e.g., "0_0", "3_5", "7_7").
   *
   * This format matches the gateway's expected `chunkId` field in stroke_event
   * messages and will be used as the locking key in Phase 5 (Optimistic Locking).
   *
   * @param {number} x - X coordinate in canvas pixels.
   * @param {number} y - Y coordinate in canvas pixels.
   * @returns {string} Chunk identifier, e.g., "0_0".
   */
  function calculateChunkId(x, y) {
    const el = canvasRef.value;
    if (!el) return '0_0';

    const chunkWidth = el.width / CHUNK_GRID_SIZE;
    const chunkHeight = el.height / CHUNK_GRID_SIZE;

    const col = Math.min(Math.floor(x / chunkWidth), CHUNK_GRID_SIZE - 1);
    const row = Math.min(Math.floor(y / chunkHeight), CHUNK_GRID_SIZE - 1);

    return `${col}_${row}`;
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Disconnects the ResizeObserver to prevent memory leaks.
   * Must be called from the consuming component's onUnmounted hook.
   */
  function destroyCanvas() {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    ctx = null;
  }

  return {
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
  };
}

/**
 * Converts a hex color string to RGB channels.
 *
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number }}
 */
function hexToRgb(hex) {
  const normalized = hex.replace('#', '');
  const full = normalized.length === 3
    ? normalized.split('').map((char) => char + char).join('')
    : normalized.padEnd(6, '0').slice(0, 6);

  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

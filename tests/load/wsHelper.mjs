/**
 * wsHelper.mjs
 * ------------
 * Utilitário compartilhado pelos scripts de teste. Abre uma conexão WebSocket
 * contra o ponto de entrada distribuído (Nginx → réplicas do Gateway) e expõe
 * um helper de request/reply por correlationId, espelhando o protocolo real do
 * frontend (useWebSocket.js).
 *
 * Node 21+ possui `WebSocket` global; para versões anteriores, faz fallback
 * dinâmico para o pacote `ws` (instale com `npm i ws` dentro de tests/).
 */

export const DEFAULT_WS_URL = process.env.AQUARELA_WS_URL || 'ws://localhost:80';

/**
 * Resolve o construtor de WebSocket disponível no runtime.
 * @returns {Promise<typeof WebSocket>}
 */
export async function getWebSocketCtor() {
  if (typeof globalThis.WebSocket === 'function') {
    return globalThis.WebSocket;
  }
  try {
    const mod = await import('ws');
    return mod.WebSocket ?? mod.default;
  } catch {
    throw new Error(
      'WebSocket indisponível. Use Node 21+ ou rode `npm i ws` dentro de tests/.'
    );
  }
}

/**
 * Abre uma conexão e resolve quando ela estiver pronta.
 * @param {string} url
 * @returns {Promise<WebSocket>}
 */
export async function openConnection(url = DEFAULT_WS_URL) {
  const Ctor = await getWebSocketCtor();
  const ws = new Ctor(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(e?.error ?? new Error('ws error')));
  });
  return ws;
}

/**
 * Envia um payload e aguarda a resposta correlacionada por correlationId
 * (interação SÍNCRONA/bloqueante — ex.: join_room → canvas_state).
 * @param {WebSocket} ws
 * @param {object} payload
 * @param {string} responseType
 * @param {number} [timeoutMs]
 * @returns {Promise<object>}
 */
export function sendRequest(ws, payload, responseType, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const correlationId =
      globalThis.crypto?.randomUUID?.() ?? `cid-${Date.now()}-${Math.random()}`;

    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error(`timeout aguardando '${responseType}' após ${timeoutMs}ms`));
    }, timeoutMs);

    function onMessage(event) {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.correlationId !== correlationId) return;
      if (data.type === responseType) {
        clearTimeout(timer);
        ws.removeEventListener('message', onMessage);
        resolve(data);
      } else if (data.type === 'error') {
        clearTimeout(timer);
        ws.removeEventListener('message', onMessage);
        reject(new Error(data.message || 'request failed'));
      }
    }

    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ ...payload, correlationId }));
  });
}

/** Envia um payload fire-and-forget. */
export function send(ws, payload) {
  ws.send(JSON.stringify(payload));
}

/** Adiciona um listener JSON tipado; retorna a função de remoção. */
export function onType(ws, type, handler) {
  function listener(event) {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === type) handler(data);
  }
  ws.addEventListener('message', listener);
  return () => ws.removeEventListener('message', listener);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

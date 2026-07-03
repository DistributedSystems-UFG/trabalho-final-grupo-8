/**
 * join_restore.mjs — Cenário T1/T5.
 *
 * Executa o handshake SÍNCRONO/bloqueante: envia `join_room` e aguarda o
 * `canvas_state` correlacionado, imprimindo o estado restaurado (chunks +
 * versões OCC). Usado para provar a comunicação síncrona (T1) e a restauração
 * de estado após restart do Gateway (T5).
 *
 * Uso: node tests/load/join_restore.mjs [roomId] [userId]
 */
import { openConnection, sendRequest, DEFAULT_WS_URL } from './wsHelper.mjs';

const roomId = process.argv[2] || 'sala-t1';
const userId = process.argv[3] || `user-${Date.now()}`;

const ws = await openConnection();
console.log(`[join_restore] conectado a ${DEFAULT_WS_URL} — join room=${roomId} user=${userId}`);

const t0 = Date.now();
const state = await sendRequest(ws, { type: 'join_room', roomId, userId }, 'canvas_state');
const elapsed = Date.now() - t0;

console.log(`[join_restore] canvas_state recebido em ${elapsed}ms — clientCount=${state.clientCount}`);
console.log(`[join_restore] ${state.chunks.length} chunk(s) restaurado(s):`);
for (const chunk of state.chunks) {
  const n = Array.isArray(chunk.strokes) ? chunk.strokes.length : 0;
  console.log(`  • chunk=${chunk.chunkId}  version=${chunk.version}  strokes=${n}`);
}

ws.close();
process.exit(0);

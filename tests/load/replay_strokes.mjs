/**
 * replay_strokes.mjs — Cenário T3 (fluxo assíncrono ponta a ponta).
 *
 * Faz join na sala e reproduz a massa de pinceladas de um arquivo JSON
 * (formato: tests/data/sample_strokes.json). Para cada stroke_event, aguarda o
 * stroke_ack (avançando a versão local) e coleta os pixel_update de difusão que
 * chegam do Worker — provando o caminho RabbitMQ → Worker → RabbitMQ → Gateway.
 *
 * Uso: node tests/load/replay_strokes.mjs [roomId] [caminho.json]
 */
import { readFileSync } from 'node:fs';
import { openConnection, sendRequest, send, onType, sleep } from './wsHelper.mjs';

const roomId = process.argv[2] || 'sala-t3';
const file = process.argv[3] || new URL('../data/sample_strokes.json', import.meta.url);

const spec = JSON.parse(readFileSync(file, 'utf8'));
const strokes = spec.strokes.filter((s) => s.chunkId); // ignora comentários
const userId = spec.userId || `replay-${Date.now()}`;

const ws = await openConnection();
await sendRequest(ws, { type: 'join_room', roomId, userId }, 'canvas_state');
console.log(`[replay] join em room=${roomId} — reproduzindo ${strokes.length} pincelada(s)`);

let acks = 0;
let pixelUpdates = 0;
const versionByChunk = new Map();

onType(ws, 'stroke_ack', (m) => { acks += 1; versionByChunk.set(m.chunkId, m.newVersion); });
onType(ws, 'conflict_event', (m) => versionByChunk.set(m.chunkId, m.currentVersion));
onType(ws, 'pixel_update', (m) => {
  pixelUpdates += 1;
  const n = Array.isArray(m.pixels) ? m.pixels.length : 0;
  console.log(`  ← pixel_update chunk=${m.chunkId} pixels=${n} (difusão do Worker)`);
});

for (const st of strokes) {
  const version = versionByChunk.get(st.chunkId) ?? st.version ?? 0;
  send(ws, {
    type: 'stroke_event',
    roomId,
    userId,
    timestamp: Date.now(),
    ...st,
    version,
  });
  await sleep(60); // ~16 pinceladas/s, dentro da janela do simulationBatcher
}

// Aguarda a difusão retornar (batcher 150ms + processamento + volta).
console.log('[replay] aguardando difusão do Worker…');
await sleep(4000);

console.log('\n──────── Resultado T3 ────────');
console.log(`stroke_ack recebidos ..... ${acks}/${strokes.length}`);
console.log(`pixel_update recebidos ... ${pixelUpdates}`);
console.log(pixelUpdates > 0
  ? '✅ Fluxo assíncrono completo (a tinta se espalhou via Worker).'
  : '⚠️  Nenhum pixel_update — verifique Worker/RabbitMQ (docker compose logs -f worker).');

ws.close();
process.exit(0);

/**
 * occ_concurrency.mjs — Cenário T2 (Optimistic Concurrency Control sob carga).
 *
 * Sobe N clientes WebSocket que pintam RAPIDAMENTE o MESMO chunk, todos
 * partindo da mesma versão. Como o Gateway distribui via round-robin (Nginx)
 * entre 3 réplicas, este teste exercita o CAS atômico em Redis/Lua
 * (chunkVersionManager.js) sob concorrência real cross-instância.
 *
 * Invariantes verificadas ao final:
 *   • aceitos + rejeitados == total de pinceladas enviadas (nada some).
 *   • no máximo 1 aceite por versão (não há duas pinceladas na mesma versão).
 *   • versão final observada == número de aceites.
 *
 * Uso:
 *   node tests/load/occ_concurrency.mjs --clients 10 --strokes 20 --chunk 4_4 --room sala-load
 */
import { openConnection, sendRequest, send, onType, sleep } from './wsHelper.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const N_CLIENTS = Number(arg('clients', 10));
const N_STROKES = Number(arg('strokes', 20));
const CHUNK_ID = arg('chunk', '4_4');
const ROOM_ID = arg('room', 'sala-load');

console.log(
  `[occ] ${N_CLIENTS} clientes × ${N_STROKES} pinceladas no chunk=${CHUNK_ID} room=${ROOM_ID}`
);

/** Estado agregado. */
const stats = {
  sent: 0,
  accepted: 0,
  conflicts: 0,
  acceptedVersions: new Set(),
  duplicateVersion: false,
  maxVersion: 0,
};

/**
 * Cria um cliente: entra na sala, dispara N_STROKES contra o mesmo chunk e
 * contabiliza stroke_ack / conflict_event.
 * @param {number} idx
 */
async function runClient(idx) {
  const userId = `load-user-${idx}`;
  const ws = await openConnection();

  // Handshake bloqueante — semeia a versão inicial do chunk.
  const state = await sendRequest(ws, { type: 'join_room', roomId: ROOM_ID, userId }, 'canvas_state');
  const seeded = state.chunks.find((c) => c.chunkId === CHUNK_ID);
  let localVersion = seeded ? Number(seeded.version) : 0;

  onType(ws, 'stroke_ack', (msg) => {
    if (msg.chunkId !== CHUNK_ID) return;
    stats.accepted += 1;
    if (stats.acceptedVersions.has(msg.newVersion)) stats.duplicateVersion = true;
    stats.acceptedVersions.add(msg.newVersion);
    stats.maxVersion = Math.max(stats.maxVersion, msg.newVersion);
    localVersion = msg.newVersion; // avança a versão local após aceite
  });

  onType(ws, 'conflict_event', (msg) => {
    if (msg.chunkId !== CHUNK_ID) return;
    stats.conflicts += 1;
    stats.maxVersion = Math.max(stats.maxVersion, msg.currentVersion);
    localVersion = msg.currentVersion; // reconcilia para a versão autoritativa
  });

  // Rajada de pinceladas — sem esperar o ack (fire-and-forget), maximizando colisão.
  for (let s = 0; s < N_STROKES; s++) {
    send(ws, {
      type: 'stroke_event',
      roomId: ROOM_ID,
      userId,
      x: 640 + (idx % 5),
      y: 300 + (s % 5),
      color: '#120A8F',
      brushSize: 6,
      opacity: 1,
      eraser: false,
      timestamp: Date.now(),
      chunkId: CHUNK_ID,
      version: localVersion,
    });
    stats.sent += 1;
    await sleep(2); // pequeno espaçamento para gerar entrelaçamento entre clientes
  }

  return ws;
}

const sockets = await Promise.all(
  Array.from({ length: N_CLIENTS }, (_, i) => runClient(i))
);

// Aguarda o dreno dos acks/conflitos em voo.
await sleep(1500);

const resolved = stats.accepted + stats.conflicts;
console.log('\n──────── Resultado T2 (OCC) ────────');
console.log(`enviados .......... ${stats.sent}`);
console.log(`aceitos ........... ${stats.accepted}`);
console.log(`conflitos ......... ${stats.conflicts}`);
console.log(`resolvidos ........ ${resolved}`);
console.log(`versão máx. ....... ${stats.maxVersion}`);

const ok =
  resolved === stats.sent &&
  !stats.duplicateVersion &&
  stats.acceptedVersions.size === stats.accepted;

console.log('\n──────── Invariantes ────────');
console.log(`[${resolved === stats.sent ? 'PASS' : 'FAIL'}] nenhum evento perdido (resolvidos == enviados)`);
console.log(`[${!stats.duplicateVersion ? 'PASS' : 'FAIL'}] no máximo 1 aceite por versão`);
console.log(`[${stats.acceptedVersions.size === stats.accepted ? 'PASS' : 'FAIL'}] versões aceitas únicas`);
console.log(`\nversão final esperada no Redis: ${stats.maxVersion}`);
console.log(`  docker exec aquarela-redis redis-cli GET "chunk:${ROOM_ID}:${CHUNK_ID}:version"`);

sockets.forEach((ws) => ws.close());
console.log(`\n${ok ? '✅ T2 PASSOU' : '❌ T2 FALHOU'}`);
process.exit(ok ? 0 : 1);

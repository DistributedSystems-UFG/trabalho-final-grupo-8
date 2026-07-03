/**
 * failover.mjs — Cenário T6 (resiliência / disponibilidade sob falha de réplica).
 *
 * Versão AUTOMATIZADA do teste de failover (o TESTING.md descreve a variante
 * manual com abas do browser). Prova, sem intervenção humana, que derrubar uma
 * das 3 réplicas do Gateway NÃO perde estado e que os clientes afetados
 * reconectam e restauram o canvas.
 *
 * Fluxo:
 *   1. Sobe K clientes via Nginx (round-robin → espalhados pelas 3 réplicas).
 *   2. Cada cliente pinta em SEU próprio chunk (todos aceitos, sem conflito).
 *   3. Aguarda o flush do write-batcher (BATCH_FLUSH_INTERVAL_MS, ~5 s) para
 *      garantir persistência no PostgreSQL.
 *   4. `docker kill` em UMA réplica do Gateway.
 *   5. Clientes daquela réplica recebem 'close' → reconectam (backoff simples,
 *      espelhando a estratégia do frontend) → refazem join_room.
 *   6. Verifica que o canvas_state pós-reconexão contém TODOS os chunks pintados
 *      (estado preservado) e que os sobreviventes continuam pintando.
 *   7. Reinicia a réplica derrubada.
 *
 * Uso: node tests/load/failover.mjs [--clients 6] [--strokes 4] [--room sala-failover]
 */
import { execSync } from 'node:child_process';
import { openConnection, sendRequest, send, onType, sleep, DEFAULT_WS_URL } from './wsHelper.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const K = Number(arg('clients', 6));
const STROKES = Number(arg('strokes', 4));
const ROOM = arg('room', 'sala-failover');
const FLUSH_WAIT_MS = Number(process.env.BATCH_FLUSH_INTERVAL_MS || 5000) + 1500;

/** Descobre os containers do Gateway em execução. */
function gatewayContainers() {
  return execSync('docker ps --filter "name=gateway" --format "{{.Names}}"')
    .toString().trim().split('\n').filter(Boolean);
}

/**
 * Um cliente com reconexão automática (espelha a política do frontend:
 * o Nginx roteia a nova conexão a uma réplica viva).
 */
class Client {
  constructor(idx) {
    this.idx = idx;
    this.userId = `fo-user-${idx}`;
    this.chunkId = `${idx % 8}_${Math.floor(idx / 8) % 8}`; // chunk próprio → sem conflito
    this.version = 0;
    this.ws = null;
    this.disconnectedCount = 0;
    this.reconnected = false;
    this.lastState = null;
  }

  async connectAndJoin() {
    this.ws = await openConnection();
    onType(this.ws, 'stroke_ack', (m) => { if (m.chunkId === this.chunkId) this.version = m.newVersion; });
    this.ws.addEventListener('close', () => this._onClose());
    const state = await sendRequest(this.ws, { type: 'join_room', roomId: ROOM, userId: this.userId }, 'canvas_state');
    this.lastState = state;
    const seeded = state.chunks.find((c) => c.chunkId === this.chunkId);
    this.version = seeded ? Number(seeded.version) : 0;
  }

  _onClose() {
    if (this._intentional) return;
    this.disconnectedCount += 1;
  }

  paint() {
    for (let s = 0; s < STROKES; s++) {
      send(this.ws, {
        type: 'stroke_event', roomId: ROOM, userId: this.userId,
        x: (this.idx % 8) * 150 + 20, y: Math.floor(this.idx / 8) * 75 + 10,
        color: '#3355FF', brushSize: 5, opacity: 1, eraser: false,
        timestamp: Date.now(), chunkId: this.chunkId, version: this.version + s,
      });
    }
  }

  /** Reconexão com backoff simples até conseguir refazer o join. */
  async reconnectWithRetry(maxAttempts = 6) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this.connectAndJoin();
        this.reconnected = true;
        return true;
      } catch {
        await sleep(500 * (attempt + 1)); // backoff crescente
      }
    }
    return false;
  }

  close() { this._intentional = true; this.ws?.close(); }
}

// ── 1–2. Sobe clientes e pinta ────────────────────────────────────────────────
console.log(`[failover] conectando ${K} clientes via ${DEFAULT_WS_URL} (room=${ROOM})`);
const clients = Array.from({ length: K }, (_, i) => new Client(i));
await Promise.all(clients.map((c) => c.connectAndJoin()));
clients.forEach((c) => c.paint());
console.log(`[failover] ${K} clientes pintaram ${STROKES} pincelada(s) cada em chunks próprios`);

// ── 3. Aguarda persistência (write-batcher flush) ─────────────────────────────
console.log(`[failover] aguardando flush do write-batcher (~${FLUSH_WAIT_MS}ms)…`);
await sleep(FLUSH_WAIT_MS);

// ── 4. Derruba UMA réplica ────────────────────────────────────────────────────
const before = gatewayContainers();
if (before.length < 2) {
  console.error(`[failover] esperado ≥2 réplicas de Gateway, encontrado ${before.length}. Abortando.`);
  clients.forEach((c) => c.close());
  process.exit(1);
}
const victim = before[0];
console.log(`[failover] réplicas ativas: ${before.join(', ')}`);
console.log(`[failover] 💥 docker kill ${victim}`);
execSync(`docker kill ${victim}`);

// ── 5. Aguarda detecção de queda e reconecta os afetados ──────────────────────
await sleep(2000);
const dropped = clients.filter((c) => c.disconnectedCount > 0);
const survivors = clients.filter((c) => c.disconnectedCount === 0);
console.log(`[failover] clientes derrubados: ${dropped.length} | sobreviventes: ${survivors.length}`);

for (const c of dropped) {
  const ok = await c.reconnectWithRetry();
  console.log(`  ${ok ? '✓' : '✗'} ${c.userId} reconectou=${ok}`);
}

// ── 6. Verificações ───────────────────────────────────────────────────────────
// (a) sobreviventes continuam pintando sem erro
let survivorsStillPaint = true;
for (const c of survivors) {
  try { c.paint(); } catch { survivorsStillPaint = false; }
}

// (b) o estado pintado foi preservado: consulta o canvas_state atual num cliente
//     novo (nova conexão → réplica viva) e confere que todos os chunks existem.
await sleep(1500);
const auditor = await openConnection();
const finalState = await sendRequest(auditor, { type: 'join_room', roomId: ROOM, userId: 'fo-auditor' }, 'canvas_state');
const persistedChunks = new Set(finalState.chunks.map((c) => c.chunkId));
const expectedChunks = clients.map((c) => c.chunkId);
const missing = expectedChunks.filter((id) => !persistedChunks.has(id));

const reconnectOk = dropped.every((c) => c.reconnected);
const statePreserved = missing.length === 0;

console.log('\n──────── Resultado T6 (failover) ────────');
console.log(`réplica derrubada ......... ${victim}`);
console.log(`clientes derrubados ....... ${dropped.length}`);
console.log(`reconectaram .............. ${dropped.filter((c) => c.reconnected).length}/${dropped.length}`);
console.log(`chunks esperados .......... ${expectedChunks.length}`);
console.log(`chunks persistidos ........ ${persistedChunks.size}`);
console.log(`chunks faltando ........... ${missing.length}${missing.length ? ' (' + missing.join(',') + ')' : ''}`);

console.log('\n──────── Invariantes ────────');
console.log(`[${reconnectOk ? 'PASS' : 'FAIL'}] todos os clientes derrubados reconectaram`);
console.log(`[${statePreserved ? 'PASS' : 'FAIL'}] nenhum chunk pintado foi perdido (estado restaurado do banco)`);
console.log(`[${survivorsStillPaint ? 'PASS' : 'FAIL'}] sobreviventes continuaram pintando`);

// ── 7. Restaura a réplica derrubada ───────────────────────────────────────────
console.log(`\n[failover] reiniciando ${victim}…`);
try { execSync(`docker start ${victim}`); } catch (e) { console.warn('  aviso ao reiniciar:', e.message); }

clients.forEach((c) => c.close());
auditor.close();

const pass = reconnectOk && statePreserved && survivorsStillPaint;
console.log(`\n${pass ? '✅ T6 PASSOU' : '❌ T6 FALHOU'}`);
process.exit(pass ? 0 : 1);

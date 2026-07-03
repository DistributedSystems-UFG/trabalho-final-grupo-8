/**
 * publish_malformed.mjs — Cenário T4 (Dead Letter Queue).
 *
 * Publica payloads corrompidos DIRETAMENTE na fila fluid_simulation_jobs
 * (exchange `aquarela_events`, routing key `fluid_simulation_jobs`), sem passar
 * pelo Gateway. O Worker (consumer.py) deve nack'ar cada job inválido com
 * requeue=False, encaminhando-o para fluid_simulation_jobs.dlq.
 *
 * Requer o pacote amqplib. A partir da raiz do repo, a forma mais simples é
 * reutilizar o já instalado no Gateway:
 *   node --experimental-vm-modules tests/load/publish_malformed.mjs   # (Node resolve via ../..)
 * ou instalar em tests/: `npm i amqplib`.
 *
 * Credenciais lidas de: RABBITMQ_USER, RABBITMQ_PASSWORD, RABBITMQ_VHOST
 * (exporte-as ou rode com `env $(grep -v '^#' .env | xargs) node …`).
 *
 * Uso: node tests/load/publish_malformed.mjs [caminho.json]
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const file = process.argv[2] || new URL('../data/malformed_jobs.json', import.meta.url);
const spec = JSON.parse(readFileSync(file, 'utf8'));

// Resolve amqplib a partir do Gateway (onde já está instalado) ou de tests/.
const require = createRequire(import.meta.url);
let amqp;
for (const path of ['amqplib', '../../gateway/node_modules/amqplib']) {
  try { amqp = require(path); break; } catch { /* tenta o próximo */ }
}
if (!amqp) {
  console.error('amqplib não encontrado. Rode `npm i amqplib` em tests/ ou garanta gateway/node_modules.');
  process.exit(1);
}

const USER = process.env.RABBITMQ_USER || 'guest';
const PASS = process.env.RABBITMQ_PASSWORD || 'guest';
const VHOST = process.env.RABBITMQ_VHOST || '/';
const HOST = process.env.RABBITMQ_HOST || 'localhost';
const url = `amqp://${USER}:${PASS}@${HOST}:5672/${encodeURIComponent(VHOST)}`;

const EXCHANGE = 'aquarela_events';
const ROUTING_KEY = 'fluid_simulation_jobs';

const conn = await amqp.connect(url);
const ch = await conn.createChannel();

let published = 0;
const tally = { drop: 0, dlq: 0, ok: 0 };
for (const c of spec.cases) {
  ch.publish(EXCHANGE, ROUTING_KEY, Buffer.from(c.raw, 'utf8'));
  published += 1;
  if (c.expected in tally) tally[c.expected] += 1;
  console.log(`→ publicado (${c.raw.length} bytes) [${c.expected ?? '?'}]: ${c.reason}`);
}

await ch.close();
await conn.close();

console.log(`\n[dlq] ${published} mensagem(ns) publicada(s) em '${ROUTING_KEY}'.`);
console.log('\nComportamento esperado (política de dois níveis do Worker):');
console.log(`  • ${tally.drop} descartado(s)/ack (malformado reconhecido) — NÃO vai para a DLQ`);
console.log(`  • ${tally.dlq} em fluid_simulation_jobs.dlq (falha inesperada)`);
console.log(`  • ${tally.ok} processado(s) com sucesso`);
console.log('\nVerificação:');
console.log('  docker compose logs --tail=50 worker | grep -i "malformed\\|TypeError"');
console.log('  docker exec aquarela-rabbitmq rabbitmqctl list_queues name messages | grep -E "jobs|dlq"');
process.exit(0);

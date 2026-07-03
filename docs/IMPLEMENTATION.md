# Documentação de Implementação — Aquarela.io

> Este documento detalha **como** o sistema foi implementado, módulo a módulo,
> complementando a [ARCHITECTURE.md](ARCHITECTURE.md) (que descreve o **quê** e o
> **porquê** das decisões). O foco aqui é o fluxo de dados real, os contratos de
> mensagem e os pontos de código que materializam cada requisito de Sistemas
> Concorrentes e Distribuídos.

---

## Sumário

1. [Visão de Fluxo Ponta a Ponta](#1-visão-de-fluxo-ponta-a-ponta)
2. [Contrato de Mensagens (WebSocket)](#2-contrato-de-mensagens-websocket)
3. [Gateway (Node.js)](#3-gateway-nodejs)
4. [Worker (Python)](#4-worker-python)
5. [Frontend (Vue.js)](#5-frontend-vuejs)
6. [Persistência e Replicação (PostgreSQL)](#6-persistência-e-replicação-postgresql)
7. [Mensageria (RabbitMQ)](#7-mensageria-rabbitmq)
8. [Concorrência Distribuída (Redis + OCC)](#8-concorrência-distribuída-redis--occ)
9. [Escala Horizontal (Nginx + Fanout)](#9-escala-horizontal-nginx--fanout)
10. [Parâmetros Configuráveis](#10-parâmetros-configuráveis)
11. [Mapa Requisito → Código](#11-mapa-requisito--código)

---

## 1. Visão de Fluxo Ponta a Ponta

O ciclo de vida de uma pincelada atravessa todos os componentes distribuídos:

```
1. Usuário arrasta o mouse no <PaintCanvas>            (frontend/src/components/PaintCanvas.vue)
2. useCanvas calcula chunkId a partir de (x, y)        (frontend/src/composables/useCanvas.js)
3. Renderização OTIMISTA local imediata (feedback)     ← não espera o servidor
4. stroke_event enviado via WebSocket (fire-and-forget)(frontend/src/composables/useWebSocket.js)
5. Nginx faz round-robin → 1 das 3 réplicas do Gateway (infra/nginx/nginx.conf)
6. Gateway valida OCC no Redis (CAS atômico via Lua)   (gateway/src/chunkVersionManager.js)
   ├─ REJEITADO → conflict_event de volta ao autor     (fim do fluxo)
   └─ ACEITO    → segue ↓
7. stroke_ack ao autor + broadcast local aos vizinhos  (gateway/src/messageHandler.js)
8. publish no fanout da sala (sincroniza réplicas B/C)  (gateway/src/roomBroadcastBus.js)
9. enfileira na persistência (write-batcher)           (gateway/src/writeBatcher.js)
10. enfileira no simulation-batcher (janela de 150 ms)  (gateway/src/simulationBatcher.js)
11. job publicado em fluid_simulation_jobs (RabbitMQ)   (gateway/src/simulationPublisher.js)
12. Worker consome, roda difusão gaussiana em NumPy     (worker/src/fluid_simulator.py)
13. pixels difundidos publicados em simulation_results  (worker/src/publisher.py)
14. Gateway consome resultados e faz broadcast          (gateway/src/simulationResultsConsumer.js)
15. pixel_update chega aos clientes → tinta se espalha  (frontend renderiza o diff)
```

**Dois caminhos temporais distintos:**

- **Síncrono/bloqueante:** apenas o `join_room` → `canvas_state` (request/reply
  por `correlationId`). O canvas só é habilitado após o estado ser restaurado.
- **Assíncrono/fire-and-forget:** todo o resto (`stroke_event`, `pixel_update`).
  O Gateway nunca bloqueia esperando o Worker.

---

## 2. Contrato de Mensagens (WebSocket)

Todas as mensagens são JSON com um campo `type`. Roteadas em
`gateway/src/messageHandler.js` → `handleMessage()`.

### Cliente → Gateway

| `type` | Direção | Campos | Semântica |
|---|---|---|---|
| `join_room` | C→G | `roomId`, `userId`, `correlationId` | **Bloqueante.** Solicita entrada e restauração de estado. |
| `stroke_event` | C→G | `roomId`, `userId`, `x`, `y`, `color`, `brushSize`, `opacity?`, `eraser?`, `timestamp`, `chunkId`, `version` | Fire-and-forget. Uma pincelada. |

### Gateway → Cliente

| `type` | Direção | Campos | Semântica |
|---|---|---|---|
| `canvas_state` | G→C | `roomId`, `clientCount`, `chunks[]`, `correlationId` | **ACK do join.** Estado completo + versões OCC por chunk. |
| `stroke_ack` | G→C | `chunkId`, `newVersion` | Confirma aceitação; cliente avança sua versão local. |
| `conflict_event` | G→C | `roomId`, `chunkId`, `rejectedVersion`, `currentVersion` | OCC rejeitou; cliente reconcilia. |
| `stroke_event` | G→C | (mesmos campos + `version`) | Broadcast de pincelada de outro usuário. |
| `client_joined` | G→C | `userId`, `clientCount` | Notificação social. |
| `pixel_update` | G→C | `chunkId`, `pixels[]` (`{x,y,r,g,b,a}`) | Resultado da simulação (difusão). |
| `error` | G→C | `message` | Payload inválido. |

**Payload canônico de `stroke_event`:**

```json
{
  "type": "stroke_event",
  "roomId": "sala-demo",
  "userId": "user-abc",
  "x": 640, "y": 300,
  "color": "#120A8F",
  "brushSize": 8,
  "opacity": 1.0,
  "eraser": false,
  "timestamp": 1751430000000,
  "chunkId": "4_4",
  "version": 0
}
```

> `chunkId` tem o formato `"col_row"` (ex.: `"4_4"`), derivado da grade
> `CHUNK_GRID_SIZE × CHUNK_GRID_SIZE` (8×8) sobre um canvas de 1200×600 px →
> cada chunk mede **150×75 px** (`chunk_processor.py`: `CHUNK_W`, `CHUNK_H`).

---

## 3. Gateway (Node.js)

Responsável por I/O intensivo: conexões WebSocket, decisão de concorrência e
roteamento para a mensageria. **Não** faz cálculo pesado.

| Módulo | Responsabilidade (SRP) |
|---|---|
| `index.js` | Bootstrap: HTTP+WS, verifica pools, inicia timers, *graceful shutdown* (flush no SIGTERM/SIGINT). |
| `wsServer.js` | Ciclo de vida das conexões WebSocket. |
| `messageHandler.js` | Parse/validação/roteamento por `type`; lógica do `join_room` (bloqueante) e `stroke_event` (OCC). |
| `roomManager.js` | Registro de salas e `broadcastToRoom()` local. |
| `chunkVersionManager.js` | OCC distribuído — CAS atômico via Lua no Redis. |
| `writeBatcher.js` | Acumula strokes e faz *upsert* em lote no PostgreSQL. |
| `simulationBatcher.js` | Agrupa strokes em janela de 150 ms → 1 job por chunk. |
| `simulationPublisher.js` | Publica jobs em `fluid_simulation_jobs`. |
| `simulationResultsConsumer.js` | Consome `simulation_results` → broadcast `pixel_update`. |
| `roomBroadcastBus.js` | Fanout entre réplicas; dedup por `INSTANCE_ID`. |
| `db/pool.js` | Pools de escrita (primário) e leitura (réplica). |
| `db/chunkRepository.js` | SQL de `canvas_chunks` (upsert append-only, fetch com fallback). |

**Detalhe crítico — `handleStrokeEvent` (`messageHandler.js`):** a decisão OCC é
`await chunkVersionManager.tryAcceptStroke(...)`. Só após o **ACEITE** o Gateway
(a) manda `stroke_ack`, (b) faz broadcast local, (c) publica no fanout, (d)
enfileira na persistência e (e) enfileira na simulação. No **REJEITE** envia
apenas `conflict_event` ao autor — a pincelada nunca alcança outros canvases.

**Compatibilidade retroativa:** `opacity` (default `1`), `eraser` (default
`false`) e `version` (default `0`) são opcionais para clientes anteriores às
fases correspondentes.

---

## 4. Worker (Python)

Consome jobs, roda a matemática de fluidos e devolve apenas os pixels que
mudaram (diff). Projetado para **não bloquear** o event loop asyncio.

| Módulo | Responsabilidade |
|---|---|
| `main.py` | Bootstrap: conexão AMQP robusta, pool asyncpg, `ThreadPoolExecutor`, inicia consumer. |
| `consumer.py` | Consome `fluid_simulation_jobs`; back-pressure via `Semaphore` + QoS prefetch; nack→DLQ. |
| `chunk_processor.py` | Cache de grids em memória, replay do histórico na miss, difusão cross-chunk. |
| `fluid_simulator.py` | Motor matemático: composição de pinceladas + difusão gaussiana + extração do diff. |
| `publisher.py` | Publica `simulation_results` no exchange. |
| `amqp_connection.py` | Topologia AMQP (exchange, filas, DLQ). |

**Modelo de concorrência (`consumer.py`):**

- `asyncio.Semaphore(MAX_CONCURRENT_CHUNKS)` (default 4) limita jobs simultâneos.
- QoS `prefetch_count = MAX_CONCURRENT_CHUNKS` → o broker só entrega o que o
  Worker consegue processar (back-pressure natural).
- O NumPy roda em `run_in_executor(ThreadPoolExecutor, ...)` — como as operações
  NumPy liberam o GIL, há paralelismo real de chunks sem travar o event loop.
- Tratamento de falhas em **dois níveis** (`_handle_job`):
  - *Reconhecidamente malformados* (`JSONDecodeError`, `KeyError`,
    `UnicodeDecodeError`) são **logados e descartados (ack)** via `return` — o
    bloco `message.process()` sai limpo e confirma a mensagem; **não** vão para
    a DLQ (lixo conhecido não é acionável).
  - *Falhas inesperadas* (qualquer outra exceção) **propagam** para fora do
    `message.process(requeue=False)` → **nack** → caem na **DLQ**
    (`fluid_simulation_jobs.dlq`), sem loop infinito. Assim a DLQ contém só o
    que falhou por motivo não previsto (ex.: um job cujo JSON é uma string solta
    gera `TypeError` e é preservado para investigação).

**Motor de fluidos (`fluid_simulator.py`):**

1. **Grid RGBA** `float32` de shape `(CHUNK_H, CHUNK_W, 4)`.
2. **Composição de pinceladas** (`render_strokes_onto_grid`): carimbo circular,
   *alpha compositing* Porter-Duff *source-over*; `eraser=True` usa
   *destination-out*; `opacity` escala o alpha da fonte.
3. **Difusão** (`run_diffusion`): `scipy.ndimage.gaussian_filter` com `sigma`
   em pixels — 1 chamada equivale a ~400 passos de Euler explícito, executa em
   <5 ms e é incondicionalmente estável (sem condição CFL). O canal alpha decai
   **uma vez por job** (secagem do pigmento).
4. **Diff** (`extract_changed_pixels`): só pixels com mudança L1 > `threshold`
   viram `pixel_update`, reduzindo drasticamente o tamanho da mensagem.

**Difusão cross-chunk:** quando uma pincelada toca a borda de um chunk
(`is_cross_chunk_needed`), os vizinhos imediatos são pré-carregados
(`preload_neighbor_grids`) e a difusão roda numa janela expandida, evitando
descontinuidades visuais nas fronteiras.

---

## 5. Frontend (Vue.js)

| Módulo | Responsabilidade |
|---|---|
| `components/PaintCanvas.vue` | Captura mouse/touch, renderização otimista, semeia `chunkVersions` a partir do `canvas_state`. |
| `components/GodePalette.vue` | Seleção de cor / pincel / borracha. |
| `composables/useCanvas.js` | Grade de chunks (`CHUNK_GRID_SIZE = 8`), cálculo de `chunkId`, desenho. |
| `composables/useWebSocket.js` | Conexão WS, reconexão com backoff+jitter, request/reply por `correlationId`. |

**Renderização otimista:** a pincelada do próprio usuário é desenhada
imediatamente, sem esperar o servidor (feedback instantâneo). Por isso o
`pixel_update` só carrega o **diff da difusão** — o carimbo do pincel o cliente
já tem localmente (ver `process_job_sync`: o snapshot é tirado *após* renderizar
as pinceladas).

**Reconexão resiliente (`useWebSocket.js`):** *close* inesperado agenda
reconexão com backoff exponencial `1s→2s→4s→…` (teto 30 s) e jitter ±20% para
evitar *thundering herd* quando uma réplica do Gateway reinicia. Requisições
bloqueantes pendentes são rejeitadas no *close* para não travar o `join`.

---

## 6. Persistência e Replicação (PostgreSQL)

**Schema (`infra/postgres/init.sql`):**

```sql
CREATE TABLE canvas_chunks (
  room_id      TEXT        NOT NULL,
  chunk_id     TEXT        NOT NULL,
  pixel_data   JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- histórico de strokes (append-only)
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version      BIGINT      NOT NULL DEFAULT 0,            -- espelha o OCC do Redis
  PRIMARY KEY (room_id, chunk_id)
);
```

**Escrita (`chunkRepository.upsertChunk`):** `INSERT … ON CONFLICT DO UPDATE`
usando o operador JSONB `||` para **anexar** (não sobrescrever) as pinceladas —
seguro para escritores concorrentes. Vai sempre ao **primário** (`pool`).

**Leitura (`chunkRepository.fetchRoomChunks`):** vai à **réplica** (`readPool`)
para aliviar o primário. Se a réplica falhar, há **fallback automático** para o
primário (disponibilidade). O lag assíncrono da réplica só afeta o visual por um
instante — nunca corrompe o OCC, porque a hidratação usa *max-merge* no Redis.

**Replicação física (`infra/postgres/02-setup-replication.sh`,
`replica-entrypoint.sh`):** a réplica sobe via `pg_basebackup` + *streaming* de
WAL a partir do primário, como serviço `postgres-replica` no compose.

**Write-batching (`writeBatcher.js`):** strokes aceitos são acumulados e
persistidos em lote a cada `BATCH_FLUSH_INTERVAL_MS` (default 5000 ms),
reduzindo a pressão de escrita. No `graceful shutdown`, `flushAll()` garante
perda mínima de dados.

---

## 7. Mensageria (RabbitMQ)

**Topologia (declarada idêntica em `gateway/src/rabbitClient.js` e
`worker/src/amqp_connection.py`):**

| Recurso | Nome | Papel |
|---|---|---|
| Exchange | `aquarela_events` (direct) | Roteamento por routing key. |
| Fila | `fluid_simulation_jobs` | Jobs de simulação (Gateway → Worker). |
| Fila | `simulation_results` | Resultados (Worker → Gateway). |
| DLQ | `fluid_simulation_jobs.dlq` | Mensagens com falha/`nack`. |

A fila de jobs é declarada com `x-dead-letter-exchange: aquarela_events` e
`x-dead-letter-routing-key: fluid_simulation_jobs.dlq`, então qualquer mensagem
`nack`'d (requeue=False) é automaticamente redirecionada à DLQ para inspeção —
sem reprocessamento infinito.

**Batching de simulação (`simulationBatcher.js`):** agrupa strokes por chunk em
uma janela de ~150 ms e publica **1 job** por janela, cortando a taxa de jobs de
~30/s para ~7/s.

---

## 8. Concorrência Distribuída (Redis + OCC)

O ponto crítico da disciplina: múltiplos usuários pintando o **mesmo** chunk no
mesmo instante, agora com **3 réplicas** do Gateway.

**Por que OCC e não Pessimistic Locking?** Lock pessimista serializaria todos os
escritores do mesmo chunk, transformando o Gateway em gargalo mesmo quando
conflitos são raros. O OCC assume conflito como exceção: valida a `version` em
O(1) e só penaliza quem colidiu.

**Por que Redis (e não Map em memória)?** Com 3 processos, cada um teria seu
próprio contador: instância A aceita 5→6 e instância B, lendo 5, também aceita
5→6 — OCC quebrado. O Redis provê um **contador único compartilhado**.

**Por que Lua (e não WATCH/MULTI/EXEC)?** O script Lua roda **atomicamente em um
único round-trip**; nenhum `EVAL` concorrente para a mesma chave interliga —
mesma garantia do antigo `Map` síncrono, agora entre N réplicas.

**Script CAS (`TRY_ACCEPT_SCRIPT` em `chunkVersionManager.js`):**

```lua
local stored = tonumber(redis.call('GET', KEYS[1])) or 0
if stored == tonumber(ARGV[1]) then          -- versão do cliente confere
  redis.call('SET', KEYS[1], stored + 1, 'EX', ttl)
  return {1, stored + 1}                       -- ACEITO
else
  return {0, stored}                           -- REJEITADO (versão autoritativa)
end
```

**Hidratação idempotente (`INIT_CHUNK_SCRIPT`):** no `join_room`/restart, as
versões vêm do banco via *max-merge* (`Math.max(atual, candidato)`) — uma leitura
atrasada da réplica **nunca** rebaixa uma versão já avançada por outra instância.

**TTL:** chaves de versão expiram em 24 h (`VERSION_KEY_TTL_SECONDS`); `clearRoom`
é *no-op* proposital em multi-instância (deletar chaves de uma instância local
corromperia o OCC das demais).

---

## 9. Escala Horizontal (Nginx + Fanout)

**Load balancer (`infra/nginx/nginx.conf`):** Nginx na porta 80 faz round-robin
entre as 3 réplicas do Gateway e — **crítico** — repassa os cabeçalhos
`Upgrade`/`Connection: upgrade` para permitir *proxy* reverso de WebSocket.

**Broadcast entre réplicas (`roomBroadcastBus.js`):** como o round-robin espalha
usuários da mesma sala por réplicas diferentes, cada `stroke_event`/`pixel_update`
é publicado num exchange **fanout por sala**. Cada réplica assina o fanout da
sala quando seu primeiro cliente local entra e repassa aos seus WebSockets
locais. A réplica de origem se auto-exclui via dedup por `INSTANCE_ID`, evitando
eco duplicado.

**Failover:** se uma réplica cai, o cliente detecta o *close*, reconecta (backoff
+ jitter) — o Nginx o direciona a outra réplica e o canvas é restaurado do banco
via `join_room`.

---

## 10. Parâmetros Configuráveis

Todos via `.env` (ver [.env.example](../.env.example)):

| Variável | Default | Efeito |
|---|---|---|
| `BATCH_FLUSH_INTERVAL_MS` | `5000` | Intervalo de flush do write-batcher. |
| `MAX_CONCURRENT_CHUNKS` | `4` | Jobs simultâneos + QoS prefetch do Worker. |
| `DIFFUSION_SIGMA` | `8.0` | Raio de espalhamento da tinta (px). |
| `ALPHA_DECAY` | `0.9998` | Secagem do pigmento por job. |
| `CHANGE_THRESHOLD` | `1.0` | Sensibilidade do diff de pixels. |
| `CANVAS_WIDTH_PX` / `CANVAS_HEIGHT_PX` | `1200` / `600` | Dimensões do canvas. |
| `CHUNK_GRID_SIZE` | `8` | Divisões de chunk por eixo (deve casar com o frontend). |
| `VERSION_KEY_TTL_SECONDS` | `86400` | TTL das chaves OCC no Redis. |

> **Invariante:** `CHUNK_GRID_SIZE`, `CANVAS_WIDTH_PX` e `CANVAS_HEIGHT_PX`
> **devem** ser idênticos entre frontend (`useCanvas.js`) e Worker
> (`chunk_processor.py`), senão o `chunkId` calculado divergiria.

---

## 11. Mapa Requisito → Código

Rastreabilidade dos requisitos de Sistemas Concorrentes e Distribuídos:

| Requisito | Onde está implementado |
|---|---|
| **Comunicação síncrona/bloqueante** | `messageHandler.handleJoinRoom` + `useWebSocket.sendRequest` (`correlationId`) |
| **Comunicação assíncrona** | `stroke_event` fire-and-forget; `pixel_update` via Worker |
| **Publish/Subscribe (mensageria)** | RabbitMQ `aquarela_events`; fanout por sala em `roomBroadcastBus.js` |
| **Dead Letter Queue** | `fluid_simulation_jobs.dlq` + `message.process(requeue=False)` |
| **Concorrência / Optimistic Locking** | `chunkVersionManager.js` (CAS Lua no Redis) |
| **Particionamento de dados** | Chunks 8×8 (`useCanvas.js`, `chunk_processor.py`) |
| **Replicação de dados** | PostgreSQL primário+réplica; `readPool` + fallback (`pool.js`, `chunkRepository.js`) |
| **Processamento paralelo** | `Semaphore` + `ThreadPoolExecutor` no Worker (`consumer.py`) |
| **Escala horizontal** | 3 réplicas do Gateway + Nginx LB (`docker-compose.yml`, `nginx.conf`) |
| **Resiliência / failover** | Reconexão backoff+jitter + restauração via `join_room` + `graceful shutdown` |
| **Persistência resiliente** | Write-batching + `flushAll()` no SIGTERM (`writeBatcher.js`, `index.js`) |

---

_Documento vivo — mantenha sincronizado com o código ao evoluir as fases._

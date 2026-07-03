# Plano de Testes e Dados de Teste — Aquarela.io

> Este documento descreve os **cenários de teste**, os **dados de teste** e os
> **resultados esperados** que validam cada requisito de Sistemas Concorrentes e
> Distribuídos do projeto. Os artefatos executáveis e as massas de dados ficam
> em [`../tests/`](../tests/).

Antes de qualquer teste, suba o ambiente:

```bash
docker compose up --build -d
# aguarde todos os healthchecks (≈30–60 s na primeira vez)
docker compose ps
```

**Ponto de entrada dos testes:** `ws://localhost:80` (Nginx → round-robin nas
3 réplicas do Gateway). A porta 3000 do Gateway **não** é exposta ao host — todo
tráfego passa pelo load balancer, o que torna os testes representativos do modo
distribuído real.

---

## Matriz de Cobertura

| # | Cenário | Requisito exercitado | Artefato |
|---|---|---|---|
| T1 | Handshake bloqueante (join/restore) | Comunicação síncrona + replicação de leitura | `tests/load/join_restore.mjs` |
| T2 | Carga de concorrência no mesmo chunk | Optimistic Locking distribuído (OCC) | `tests/load/occ_concurrency.mjs` |
| T3 | Fluxo assíncrono ponta a ponta | Mensageria + simulação | `tests/data/sample_strokes.json` |
| T4 | Falhas: descarte de malformados vs. DLQ | Dead Letter Queue (dois níveis) | `tests/data/malformed_jobs.json` |
| T5 | Restauração pós-restart do Gateway | Persistência + hidratação OCC | `tests/sql/seed_canvas.sql` |
| T6 | Failover de réplica do Gateway | Resiliência / disponibilidade | `tests/load/failover.mjs` (auto) ou manual |
| T7 | Replicação primário→réplica | Replicação de dados (WAL streaming) | manual (abaixo) |

---

## T1 — Handshake Bloqueante (`join_room` → `canvas_state`)

**Objetivo:** provar que o cliente **bloqueia** aguardando o estado antes de
habilitar o canvas (única interação síncrona do sistema).

**Passos:**
```bash
node tests/load/join_restore.mjs sala-t1 user-1
```

**Resultado esperado:**
- O script envia `join_room` com `correlationId` e imprime o `canvas_state`
  correlacionado em < 5 s.
- O `canvas_state` traz `chunks[]` (vazio para sala nova) e `clientCount`.
- Se a réplica de leitura ainda não subiu, o log do Gateway mostra o **fallback
  para o primário** — o `canvas_state` chega mesmo assim.

---

## T2 — Concorrência no Mesmo Chunk (OCC sob carga)

**Objetivo:** múltiplos clientes pintam o **mesmo** `chunkId` simultaneamente;
o OCC distribuído (Redis + Lua CAS) deve aceitar exatamente uma pincelada por
versão e rejeitar as colisões com `conflict_event` — **sem corromper estado**.

**Dados de teste:** gerados pelo script (N clientes, mesmo `chunkId=4_4`,
todos partindo de `version=0`).

**Passos:**
```bash
# 10 clientes, 20 pinceladas cada, no mesmo chunk
node tests/load/occ_concurrency.mjs --clients 10 --strokes 20 --chunk 4_4
```

**Resultado esperado (invariantes):**
- `aceitos + rejeitados == total enviado` (nenhuma pincelada some).
- Para cada versão `v`, **no máximo uma** pincelada é aceita (CAS atômico).
- A versão final do chunk no Redis `== número de aceitos`.
- Colisões retornam `conflict_event` com `currentVersion` monotônico crescente.
- **Zero** corrupção: rodar 2× produz contagens consistentes.

Verificação da versão no Redis:
```bash
docker exec aquarela-redis redis-cli GET "chunk:sala-load:4_4:version"
```

---

## T3 — Fluxo Assíncrono Ponta a Ponta (simulação)

**Objetivo:** validar `stroke_event → RabbitMQ → Worker → simulation_results →
pixel_update`, e que o Gateway **não bloqueia**.

**Dados de teste:** [`tests/data/sample_strokes.json`](../tests/data/sample_strokes.json)
— sequência canônica de pinceladas (cores, opacidade, borracha, cross-chunk).

**Passos:**
```bash
node tests/load/replay_strokes.mjs sala-t3 tests/data/sample_strokes.json
```

**Resultado esperado:**
- Cada `stroke_event` recebe `stroke_ack` imediato (assíncrono, não espera o Worker).
- Em seguida chegam `pixel_update` com o **diff da difusão** (a tinta se espalha).
- Logs do Worker: `Processing job … strokes=N` e `… changed pixel(s)`.
- Fila `fluid_simulation_jobs` esvazia (não acumula): ver RabbitMQ UI
  (http://localhost:15672).

---

## T4 — Dead Letter Queue (tratamento de falhas em dois níveis)

**Objetivo:** validar a política de erros do Worker (`consumer.py`), que é
**deliberadamente de dois níveis** (ver [IMPLEMENTATION.md §4](IMPLEMENTATION.md#4-worker-python)):

- **Malformados reconhecidos** (`JSONDecodeError`, `KeyError`,
  `UnicodeDecodeError` — JSON corrompido, `roomId`/`chunkId` ausentes, encoding
  inválido) são **logados e descartados (ack)**. Não vão para a DLQ: são lixo
  conhecido e mantê-los na fila morta não agrega valor.
- **Falhas inesperadas** (qualquer outra exceção) **propagam** e caem na DLQ,
  preservando na fila morta apenas o que falhou por motivo não previsto.

**Dados de teste:** [`tests/data/malformed_jobs.json`](../tests/data/malformed_jobs.json)
— cada caso traz o campo `expected` (`drop` | `dlq` | `ok`).

**Passos:**
```bash
env $(grep -vE '^#|^$' .env | xargs) RABBITMQ_HOST=localhost \
  node tests/load/publish_malformed.mjs tests/data/malformed_jobs.json
```

**Resultado esperado (validado em execução real):**
- Logs do Worker: `Malformed simulation job — dropping (ack): …` para os 4 casos
  reconhecidos (JSON inválido, sem `roomId`, sem `chunkId`, corpo vazio).
- O caso `"string solta"` produz um `TypeError` **não previsto** → **1** mensagem
  na `fluid_simulation_jobs.dlq`.
- O job de **controle** (`strokes: []`) é processado com sucesso — **não** vai
  para a DLQ.
- A fila principal `fluid_simulation_jobs` volta a **0**.

> **Observação de projeto:** os 4 malformados reconhecidos **não** aparecem na
> DLQ — esse é o comportamento pretendido. A DLQ é reservada para falhas
> inesperadas, mantendo seu conteúdo acionável.

Inspeção:
```bash
docker exec aquarela-rabbitmq rabbitmqctl list_queues name messages | grep -E "jobs|dlq"
```

---

## T5 — Restauração pós-restart do Gateway

**Objetivo:** o estado do canvas sobrevive à queda do Gateway e o OCC é
hidratado do banco (sem `conflict_event` espúrio na primeira pincelada).

**Dados de teste:** [`tests/sql/seed_canvas.sql`](../tests/sql/seed_canvas.sql)
— semeia `canvas_chunks` com histórico e `version` conhecidos.

**Passos:**
```bash
# 1. Semear o banco
docker exec -i aquarela-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < tests/sql/seed_canvas.sql
# 2. Derrubar e subir só o Gateway
docker compose restart gateway
# 3. Entrar na sala semeada e conferir o estado restaurado
node tests/load/join_restore.mjs sala-seed user-check
```

**Resultado esperado:**
- O `canvas_state` retorna os chunks semeados com a `version` correta.
- A primeira pincelada com `version == <version restaurada>` é **aceita**
  (prova de hidratação correta do Redis via `initChunk` max-merge).

---

## T6 — Failover de Réplica do Gateway

**Objetivo:** com 3 réplicas atrás do Nginx, derrubar uma não deve perder estado.

### Variante automatizada (recomendada)

```bash
node tests/load/failover.mjs --clients 6 --strokes 4 --room sala-failover
```

O script sobe K clientes pelo Nginx, cada um pinta em seu próprio chunk, aguarda
o flush do write-batcher, executa `docker kill` em uma réplica e verifica as
invariantes: (1) todos os clientes derrubados **reconectam**; (2) **nenhum chunk
pintado é perdido** (canvas restaurado do banco); (3) os clientes das réplicas
sobreviventes **continuam pintando**. Ao final, reinicia a réplica derrubada.

**Resultado validado em execução real:** 3/6 clientes caíram (a réplica morta),
3/3 reconectaram, 6/6 chunks preservados, sobreviventes seguiram pintando →
`✅ T6 PASSOU`.

### Variante manual (com browser)

**Passos:**
1. Abra 2 abas do frontend (http://localhost:5173) na mesma sala e pinte.
2. Descubra os containers do Gateway e mate um:
   ```bash
   docker ps --filter "name=gateway" --format "{{.Names}}"
   docker kill <um-container-gateway>
   ```
3. Continue pintando nas abas.

**Resultado esperado:**
- Clientes conectados à réplica morta detectam o *close* e **reconectam**
  (backoff + jitter) — o Nginx os redireciona a outra réplica.
- Após reconectar, o `join_room` restaura o canvas do banco: **nenhum traço
  confirmado é perdido**.
- Usuários nas outras réplicas continuam pintando sem interrupção (sincronia via
  fanout por sala).

---

## T7 — Replicação PostgreSQL primário→réplica (manual)

**Objetivo:** confirmar o WAL streaming primário → `postgres-replica`.

**Passos:**
```bash
# Escreve no primário
docker exec -i aquarela-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "INSERT INTO canvas_chunks (room_id, chunk_id, version) VALUES ('repl-test','0_0',7)
      ON CONFLICT (room_id,chunk_id) DO UPDATE SET version=EXCLUDED.version;"

# Lê da réplica (deve refletir em milissegundos)
docker exec -i aquarela-postgres-replica psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT room_id, chunk_id, version FROM canvas_chunks WHERE room_id='repl-test';"
```

**Resultado esperado:**
- A réplica retorna `version = 7` (lag de ms).
- A réplica é **read-only**: um `INSERT` nela falha com
  `cannot execute INSERT in a read-only transaction`.

Status da replicação:
```bash
docker exec aquarela-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT client_addr, state, sync_state FROM pg_stat_replication;"
```

---

## Critérios de Aceite (resumo)

| Requisito | Critério objetivo |
|---|---|
| Concorrência (OCC) | T2: `aceitos+rejeitados == total`; 1 aceite por versão; zero corrupção |
| Mensageria | T3: fila de jobs não acumula; `pixel_update` entregue |
| DLQ | T4: malformados reconhecidos são descartados (ack); só falhas inesperadas vão à DLQ; fila principal zera |
| Particionamento | T3: `chunkId` correto; difusão cross-chunk sem descontinuidade |
| Replicação | T7: réplica reflete escrita do primário; réplica read-only |
| Síncrono/bloqueante | T1: `canvas_state` correlacionado antes de habilitar o canvas |
| Resiliência | T5/T6: estado restaurado após restart/failover, sem conflito espúrio |

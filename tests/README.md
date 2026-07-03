# Dados e Scripts de Teste — Aquarela.io

Massa de dados e scripts que validam os requisitos de Sistemas Concorrentes e
Distribuídos. O plano completo (cenários, passos e resultados esperados) está em
[`../docs/TESTING.md`](../docs/TESTING.md).

## Estrutura

```
tests/
├── data/
│   ├── sample_strokes.json    # T3 — pinceladas canônicas (cor, opacidade, borracha, cross-chunk)
│   └── malformed_jobs.json    # T4 — jobs corrompidos para a Dead Letter Queue
├── sql/
│   └── seed_canvas.sql        # T5/T7 — semeia canvas_chunks (histórico + versão OCC)
└── load/
    ├── wsHelper.mjs           # utilitário WebSocket (request/reply por correlationId)
    ├── join_restore.mjs       # T1/T5 — handshake bloqueante + restauração de estado
    ├── occ_concurrency.mjs    # T2 — carga de concorrência no mesmo chunk (OCC)
    ├── replay_strokes.mjs     # T3 — fluxo assíncrono ponta a ponta (simulação)
    ├── publish_malformed.mjs  # T4 — publica jobs inválidos direto no RabbitMQ
    └── failover.mjs           # T6 — mata uma réplica do Gateway e valida reconexão + estado
```

## Pré-requisitos

- Ambiente no ar: `docker compose up --build -d` (aguarde os healthchecks).
- **Node 21+** (usa o `WebSocket` global). Em Node ≤ 20, rode `npm i ws` dentro
  de `tests/` — o helper faz fallback automático para o pacote `ws`.
- O `publish_malformed.mjs` usa `amqplib` (reaproveitado de `gateway/node_modules`)
  e lê as credenciais do `.env`.

## Execução rápida

```bash
# T1 — handshake síncrono / restauração
node tests/load/join_restore.mjs sala-t1 user-1

# T2 — concorrência OCC (10 clientes × 20 pinceladas no chunk 4_4)
node tests/load/occ_concurrency.mjs --clients 10 --strokes 20 --chunk 4_4

# T3 — fluxo assíncrono ponta a ponta (difusão)
node tests/load/replay_strokes.mjs sala-t3 tests/data/sample_strokes.json

# T4 — Dead Letter Queue (carregue o .env para as credenciais do RabbitMQ)
env $(grep -v '^#' .env | xargs) node tests/load/publish_malformed.mjs

# T5 — restauração pós-restart
docker exec -i aquarela-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < tests/sql/seed_canvas.sql
docker compose restart gateway
node tests/load/join_restore.mjs sala-seed user-check

# T6 — failover automatizado (mata uma réplica, valida reconexão + estado)
node tests/load/failover.mjs --clients 6 --strokes 4
```

> O `failover.mjs` usa `docker kill`/`docker start` — precisa de acesso ao
> daemon do Docker no host onde roda.

> Os scripts apontam para `ws://localhost:80` (Nginx → réplicas do Gateway).
> Sobrescreva com `AQUARELA_WS_URL=ws://outro-host:80`.

# Aquarela.io

Alunos: Bárbara Nogueira / Davi Duarte Neco / Matheus Vieira


> Canvas colaborativo distribuído com simulação de fluidos em tempo real.

Trabalho final da disciplina de **Software Concorrente e Distribuído**. Múltiplos usuários pintam simultaneamente no mesmo canvas enquanto um motor de simulação físico calcula a difusão da água e do pigmento em background.

---

## Sumário

- [Visão Geral da Arquitetura](#visão-geral-da-arquitetura)
- [Stack Tecnológica](#stack-tecnológica)
- [Pré-requisitos](#pré-requisitos)
- [Configuração do Ambiente](#configuração-do-ambiente)
- [Rodando o Projeto](#rodando-o-projeto)
- [Serviços e Portas](#serviços-e-portas)
- [Estrutura do Repositório](#estrutura-do-repositório)
- [Variáveis de Ambiente](#variáveis-de-ambiente)
- [Desenvolvimento Local](#desenvolvimento-local)

---

## Visão Geral da Arquitetura

```
Browser (Vue.js)
      │  WebSocket
      ▼
 Nginx (Load Balancer :80)
      │  round-robin
      ▼
Gateway × 3 réplicas (Node.js)
      │           │
      │           └── Redis (OCC — versões de chunks)
      │
      ├── PostgreSQL Primary  (escritas de chunks)
      ├── PostgreSQL Replica  (leituras de restauração de canvas)
      │
      └── RabbitMQ ──► Worker (Python — simulação de fluidos)
                            │
                            └── resultado ──► Gateway ──► Broadcast WebSocket
```

**Principais decisões de arquitetura:**

- **Concorrência / OCC:** o Gateway usa *Optimistic Concurrency Control* com versões de chunks armazenadas no Redis, compartilhadas entre as 3 réplicas, para resolver colisões de pinceladas simultâneas.
- **Mensageria assíncrona:** pinceladas são enviadas ao RabbitMQ (fire-and-forget); o Worker processa a física e devolve os pixels calculados via fila de resultados.
- **Replicação de dados:** PostgreSQL em modo primário + réplica read-only via WAL streaming. O Gateway escreve no primário e lê da réplica, com fallback automático.
- **Broadcast entre réplicas:** exchanges `fanout` do RabbitMQ (`roomBroadcastBus`) garantem que `pixel_update` chegue a todos os clientes, independente de qual réplica do Gateway eles estejam conectados.

Documentação completa em [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Stack Tecnológica

| Camada | Tecnologia |
|---|---|
| Frontend | Vue.js 3 + HTML5 Canvas + Vite |
| Gateway | Node.js 20 + `ws` |
| Worker | Python 3.11 + `aio-pika` |
| Mensageria | RabbitMQ 3.13 |
| Banco de dados | PostgreSQL 16 (primário + réplica) |
| Cache / OCC | Redis 7 |
| Load Balancer | Nginx 1.25 |
| Orquestração | Docker + Docker Compose |

---

## Pré-requisitos

- [Docker](https://docs.docker.com/get-docker/) ≥ 24
- [Docker Compose](https://docs.docker.com/compose/install/) ≥ 2.20 (plugin `docker compose`)
- Git

> **WSL / Linux:** todos os comandos abaixo assumem um terminal Linux/macOS. No Windows, use o WSL 2 com Docker Desktop integrado.

---

## Configuração do Ambiente

**1. Clone o repositório**

```bash
git clone <url-do-repositório>
cd aquarela-io
```

**2. Crie o arquivo de variáveis de ambiente**

```bash
cp .env.example .env
```

Edite o `.env` e substitua todos os valores `change_me_in_env` por senhas seguras antes de subir os containers:

```bash
# Exemplo (mínimo para desenvolvimento local)
POSTGRES_PASSWORD=minhasenha123
POSTGRES_REPLICATION_PASSWORD=repsenha123
RABBITMQ_PASSWORD=rabbitsenha123
```

> O arquivo `.env` **nunca deve ser commitado**. Ele já está no `.gitignore`.

---

## Rodando o Projeto

### Subir tudo (modo desenvolvimento)

```bash
docker compose up --build
```

O Docker irá:
1. Construir as imagens do Gateway, Worker e Frontend.
2. Subir o PostgreSQL primário e aguardar o healthcheck.
3. Subir a réplica PostgreSQL (via `pg_basebackup`).
4. Subir o RabbitMQ e o Redis.
5. Subir 3 réplicas do Gateway atrás do Nginx.
6. Subir o Worker Python.
7. Subir o Frontend com hot-reload (Vite).

Aguarde até ver nos logs que todos os serviços passaram nos healthchecks. O processo completo leva cerca de 30–60 segundos na primeira vez.

### Subir em background

```bash
docker compose up --build -d
```

### Parar todos os containers

```bash
docker compose down
```

### Parar e remover volumes (reset completo do banco)

```bash
docker compose down -v
```

---

## Serviços e Portas

| Serviço | URL / Porta | Descrição |
|---|---|---|
| **Frontend** | http://localhost:5173 | Canvas Vue.js (Vite dev server) |
| **Nginx** | http://localhost:80 | Entry point da aplicação (prod-like) |
| **RabbitMQ UI** | http://localhost:15672 | Management console do RabbitMQ |
| **PostgreSQL** | `localhost:5432` | Banco primário (somente para inspeção local) |

> **Credenciais do RabbitMQ Management UI:** use `RABBITMQ_USER` e `RABBITMQ_PASSWORD` definidos no `.env`.

---

## Estrutura do Repositório

```
aquarela-io/
├── docker-compose.yml       # Orquestração de todos os serviços
├── .env.example             # Template de variáveis de ambiente
├── docs/
│   └── ARCHITECTURE.md      # Documentação da arquitetura
├── frontend/                # Vue.js + HTML5 Canvas
│   ├── src/
│   │   ├── components/      # PaintCanvas, ColorPalette
│   │   └── composables/     # useCanvas, useWebSocket
│   └── Dockerfile.dev
├── gateway/                 # Node.js — WebSocket server
│   └── src/
│       ├── index.js         # Entrypoint
│       ├── wsServer.js      # Gerenciamento de conexões WebSocket
│       ├── messageHandler.js# Roteamento de mensagens
│       ├── roomManager.js   # Salas de canvas
│       ├── simulationPublisher.js  # Publica eventos no RabbitMQ
│       ├── simulationResultsConsumer.js # Consome resultados do Worker
│       ├── chunkVersionManager.js  # OCC com Redis
│       ├── writeBatcher.js  # Batching de escritas no PostgreSQL
│       ├── roomBroadcastBus.js     # Fanout entre réplicas via RabbitMQ
│       └── db/
│           ├── pool.js      # Pool de conexões (primário + réplica)
│           └── chunkRepository.js  # Queries de chunks
├── worker/                  # Python — Motor de simulação de fluidos
│   └── src/
│       ├── main.py          # Entrypoint
│       ├── consumer.py      # Consome fila do RabbitMQ
│       ├── fluid_simulator.py  # Algoritmo de difusão de fluidos
│       ├── chunk_processor.py  # Processa chunks individuais
│       └── publisher.py     # Publica resultados de volta
└── infra/
    ├── nginx/nginx.conf     # Configuração do load balancer
    └── postgres/            # Scripts de init e replicação
```

---

## Variáveis de Ambiente

Todas as variáveis estão documentadas em [.env.example](.env.example). As mais importantes:

| Variável | Descrição |
|---|---|
| `POSTGRES_PASSWORD` | Senha do banco primário |
| `POSTGRES_REPLICATION_PASSWORD` | Senha da role de replicação WAL |
| `RABBITMQ_PASSWORD` | Senha do RabbitMQ |
| `POSTGRES_READ_HOST` | Host da réplica de leitura (padrão: `postgres-replica`) |
| `REDIS_URL` | URL do Redis para OCC (padrão: `redis://redis:6379`) |
| `BATCH_FLUSH_INTERVAL_MS` | Intervalo de flush do write batcher (padrão: `5000` ms) |
| `NODE_ENV` | Ambiente Node.js (`development` ou `production`) |

---

## Desenvolvimento Local

### Ver logs de um serviço específico

```bash
docker compose logs -f gateway
docker compose logs -f worker
docker compose logs -f frontend
```

### Rebuild de um serviço após alteração de código

```bash
docker compose up --build gateway
```

### Acessar o banco de dados diretamente

```bash
docker exec -it aquarela-postgres psql -U aquarela_user -d aquarela
```

### Inspecionar filas do RabbitMQ

Acesse http://localhost:15672 com as credenciais do `.env`.

### Escalar o Worker manualmente

```bash
docker compose up --scale worker=3 -d
```

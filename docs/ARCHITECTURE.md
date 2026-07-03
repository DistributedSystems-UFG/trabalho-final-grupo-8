# Arquitetura do Sistema: Tela de Aquarela Colaborativa Distribuída

## 1. Visão Geral
Este sistema é um editor de arte compartilhado onde múltiplos clientes desenham simultaneamente. O diferencial é a simulação computacional de fluidos: o sistema calcula em background a difusão da água e do pigmento na textura do papel.

O sistema é composto por três blocos principais, interligados por mensageria, garantindo alta disponibilidade e tratamento de concorrência.

## 2. Componentes do Sistema

### 2.1. Front-end (Cliente)
- **Tecnologia:** Vue.js + HTML5 Canvas.
- **Responsabilidade:** Capturar as pinceladas do usuário e enviá-las de forma síncrona para o servidor. Receber eventos assíncronos de atualização de pixels e renderizá-los no canvas.

### 2.2. Gateway / Servidor Principal
- **Tecnologia:** Node.js.
- **Responsabilidade:** Gerenciar as conexões WebSocket (salas). Receber as coordenadas das pinceladas, aplicar *locks* otimistas para evitar condições de corrida (múltiplos usuários pintando o exato mesmo pixel no mesmo milissegundo) e repassar os eventos para a fila de mensagens.

### 2.3. Motor de Simulação (Background Worker)
- **Tecnologia:** Python.
- **Responsabilidade:** Consumir a fila de mensagens e processar a matemática pesada da difusão de fluidos (espalhamento da tinta ao longo do tempo). Devolve o estado atualizado dos pixels calculados para o Gateway distribuir aos clientes.

## 3. Tratamento de Sistemas Distribuídos

- **Comunicação Síncrona (bloqueante):** Ao entrar numa sala, o cliente faz um `join_room` e **bloqueia** aguardando a resposta `canvas_state` (request/reply correlacionado por `correlationId`). O Gateway só responde após ler o estado do canvas no banco e hidratar as versões OCC no Redis; o canvas só é habilitado depois disso. Implementação: `gateway/src/messageHandler.js` (`handleJoinRoom`) e `frontend/src/composables/useWebSocket.js` (`sendRequest`).
- **Comunicação Assíncrona:** As pinceladas (`stroke_event`) são fire-and-forget e o espalhamento da tinta chega depois via `pixel_update` (WebSocket), calculado pelo Worker via RabbitMQ.
- **Publish-Subscribe (Mensageria):** O Node.js e o Python se comunicam através de um *Message Broker* (RabbitMQ). Entre réplicas do Gateway, o broadcast por sala usa exchanges `fanout` (`roomBroadcastBus.js`).
- **Particionamento de Dados:** O Canvas é logicamente dividido em "Chunks" (Quadrantes). Cada região da tela pode ser processada independentemente para escalar horizontalmente.
- **Replicação de Dados (streaming replication):** O PostgreSQL roda como **primário + réplica read-only** (serviço `postgres-replica` no `docker-compose.yml`, via `pg_basebackup` + WAL streaming). As **escritas** (upsert de chunks) vão ao primário; as **leituras** de restauração de canvas (`fetchRoomChunks`) saem da réplica através do `readPool` (`gateway/src/db/pool.js`), com **fallback automático para o primário** se a réplica estiver indisponível (disponibilidade). A hidratação de versões OCC usa *max-merge* no Redis, então o lag assíncrono da réplica não corrompe a concorrência.
- **Replicação de Funcionalidade e Disponibilidade:** O Gateway roda com 3 réplicas atrás do Nginx; se uma cai, os clientes reconectam e o Canvas é restaurado do banco.
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

- **Comunicação Síncrona/Assíncrona:** O cliente envia a ação de pintar e aguarda a confirmação de registro (Síncrono). A visualização do espalhamento da tinta ao longo dos segundos seguintes chega via WebSockets (Assíncrono).
- **Publish-Subscribe (Mensageria):** O Node.js e o Python se comunicam através de um *Message Broker* (ex: RabbitMQ).
- **Particionamento de Dados:** O Canvas é logicamente dividido em "Chunks" (Quadrantes). Cada região da tela pode ser processada independentemente para escalar horizontalmente.
- **Replicação e Disponibilidade:** O estado consolidado dos pixels é salvo periodicamente em réplicas de banco de dados. Caso o Gateway caia, a última versão do Canvas é restaurada do banco.
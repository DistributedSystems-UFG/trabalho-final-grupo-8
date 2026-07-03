#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Aquarela.io — Setup de replicação no PRIMÁRIO
# Executado uma única vez na primeira criação do container (roda depois de
# 01-init.sql, ainda dentro do docker-entrypoint-initdb.d).
#
# Responsabilidades:
#   1. Criar a role de replicação (REPLICATION LOGIN) usada pelo pg_basebackup
#      e pelo streaming contínuo da réplica.
#   2. Liberar conexões de replicação no pg_hba.conf para a rede interna do
#      Docker Compose (aquarela-net).
#
# Observação de decisão: os init scripts só rodam quando o volume está vazio.
# Em um ambiente já provisionado, recrie o volume (docker compose down -v) para
# que a role de replicação seja criada.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPL_USER="${POSTGRES_REPLICATION_USER:-replicator}"
REPL_PASSWORD="${POSTGRES_REPLICATION_PASSWORD:?POSTGRES_REPLICATION_PASSWORD is required}"

echo "[primary] creating replication role '${REPL_USER}'..."

# Idempotente: só cria a role se ainda não existir.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	DO \$do\$
	BEGIN
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${REPL_USER}') THEN
	    CREATE ROLE ${REPL_USER} WITH REPLICATION LOGIN PASSWORD '${REPL_PASSWORD}';
	  END IF;
	END
	\$do\$;
EOSQL

# Libera conexões de replicação da rede interna. Este arquivo é lido no start
# final do servidor (após a fase de init), então não é necessário reload aqui.
HBA_LINE="host replication ${REPL_USER} 0.0.0.0/0 scram-sha-256"
if ! grep -qF "$HBA_LINE" "$PGDATA/pg_hba.conf"; then
  echo "$HBA_LINE" >> "$PGDATA/pg_hba.conf"
  echo "[primary] pg_hba.conf: replication access granted to '${REPL_USER}'."
fi

echo "[primary] replication setup complete."

#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Aquarela.io — Entrypoint da RÉPLICA de leitura (hot standby)
#
# No primeiro boot (PGDATA vazio) faz um pg_basebackup a partir do primário e
# grava standby.signal + primary_conninfo (flag -R). Nos boots seguintes o
# PGDATA já existe e o Postgres inicia diretamente em modo standby, retomando o
# streaming de onde parou.
#
# Roda como root para poder ajustar owner/permissões do PGDATA (volume nomeado
# nasce como root) e então executa o basebackup como usuário 'postgres'.
# Ao final delega para o docker-entrypoint.sh oficial, que sobe o servidor.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

: "${PGDATA:=/var/lib/postgresql/data}"
: "${PRIMARY_HOST:=postgres}"
REPL_USER="${POSTGRES_REPLICATION_USER:-replicator}"

mkdir -p "$PGDATA"
chown -R postgres:postgres "$PGDATA"
chmod 0700 "$PGDATA"

# PG_VERSION só existe se o data dir já foi inicializado/clonado.
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[replica] waiting for primary '${PRIMARY_HOST}' to accept replication connections..."
  until pg_isready -h "$PRIMARY_HOST" -p 5432 -U "$REPL_USER" -q; do
    echo "[replica] primary not ready yet — retrying in 2s..."
    sleep 2
  done

  echo "[replica] running pg_basebackup from '${PRIMARY_HOST}'..."
  export PGPASSWORD="${POSTGRES_REPLICATION_PASSWORD:?POSTGRES_REPLICATION_PASSWORD is required}"
  # -Fp: plain format | -Xs: stream WAL | -P: progress | -R: write standby.signal
  #      e primary_conninfo para o streaming contínuo pós-restore.
  su-exec postgres pg_basebackup \
    -h "$PRIMARY_HOST" -p 5432 -U "$REPL_USER" \
    -D "$PGDATA" -Fp -Xs -P -R
  echo "[replica] base backup complete — starting as hot standby."
fi

chown -R postgres:postgres "$PGDATA"
chmod 0700 "$PGDATA"

# Delega ao entrypoint oficial (faz su-exec para 'postgres' e sobe o servidor).
exec docker-entrypoint.sh postgres

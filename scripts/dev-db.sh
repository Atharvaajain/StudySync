#!/usr/bin/env bash
# Starts the cloud container's PostgreSQL 16 and prepares the StudySync databases.
# Idempotent: safe to run any number of times. Development and test use only.
#   role      studysync / studysync   (CREATEDB is needed by `prisma migrate dev` for its shadow DB)
#   databases studysync_dev, studysync_test, studysync_e2e — all with timezone = 'UTC' (R12)
set -euo pipefail

if ! pg_lsclusters 2>/dev/null | grep -qE '^16 +main .* online'; then
  pg_ctlcluster 16 main start
fi

psql_admin() { su postgres -c "psql -v ON_ERROR_STOP=1 -qtA $*"; }

psql_admin "-c \"DO \\\$\\\$BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studysync') THEN
    CREATE ROLE studysync LOGIN PASSWORD 'studysync' CREATEDB;
  END IF;
END\\\$\\\$;\""

for db in studysync_dev studysync_test studysync_e2e; do
  if [ "$(psql_admin "-c \"SELECT 1 FROM pg_database WHERE datname = '$db'\"")" != "1" ]; then
    psql_admin "-c \"CREATE DATABASE $db OWNER studysync\""
  fi
  psql_admin "-c \"ALTER DATABASE $db SET timezone TO 'UTC'\""
done

echo "PostgreSQL ready: studysync_dev, studysync_test, studysync_e2e (user studysync, timezone UTC)"

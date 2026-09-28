#!/bin/sh
set -eu

# Restores a custom-format dump into a throwaway local database, counts rows,
# then drops that database. Does not touch the source database name.

dump=${1:-}
admin=${DATABASE_ADMIN_URL:-}
if [ -z "$dump" ] || [ -z "$admin" ]; then
  echo "Usage: DATABASE_ADMIN_URL=... scripts/restore-check.sh /path/to.dump" >&2
  exit 1
fi

base=$(node -e 'const u = new URL(process.env.DATABASE_ADMIN_URL); u.search = ""; if (!["localhost","127.0.0.1","::1"].includes(u.hostname)) process.exit(2); u.pathname = "/postgres"; process.stdout.write(u.toString())') || {
  echo "Restore checks run only against localhost." >&2
  exit 1
}

name="dukaanos_restore_$(date -u +%Y%m%d%H%M%S)"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
psql "$base" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$name\";"
target=$(node -e 'const u = new URL(process.env.DATABASE_ADMIN_URL); u.search = ""; u.pathname = "/" + process.argv[1]; process.stdout.write(u.toString())' "$name")
pg_restore --no-owner --dbname "$target" "$dump"
psql "$target" -v ON_ERROR_STOP=1 -c "SELECT 'tenants' AS table_name, count(*) FROM tenants UNION ALL SELECT 'sales', count(*) FROM sales UNION ALL SELECT 'inventory_balances', count(*) FROM inventory_balances;"
psql "$base" -v ON_ERROR_STOP=1 -c "DROP DATABASE \"$name\";"
finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "restore_started $started"
echo "restore_finished $finished"
echo "restore_result dropped $name after row counts"

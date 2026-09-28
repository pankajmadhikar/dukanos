#!/bin/sh
set -eu

# Logical backup of the database named by DATABASE_ADMIN_URL.
# Refuses a non-local host unless ALLOW_REMOTE_BACKUP=1.
# Writes a custom-format dump outside the repository by default.

if [ -z "${DATABASE_ADMIN_URL:-}" ]; then
  echo "DATABASE_ADMIN_URL is required." >&2
  exit 1
fi

host=$(node -e 'const u = new URL(process.env.DATABASE_ADMIN_URL); process.stdout.write(u.hostname)')
admin=$(node -e 'const u = new URL(process.env.DATABASE_ADMIN_URL); u.search = ""; process.stdout.write(u.toString())')
if [ "$host" != "localhost" ] && [ "$host" != "127.0.0.1" ] && [ "$host" != "::1" ] && [ "${ALLOW_REMOTE_BACKUP:-}" != "1" ]; then
  echo "Refusing a remote backup. Set ALLOW_REMOTE_BACKUP=1 only on the operator machine." >&2
  exit 1
fi

out_dir=${BACKUP_DIR:-/tmp/dukaanos-backups}
mkdir -p "$out_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="$out_dir/dukaanos-$stamp.dump"

echo "backup_started $stamp"
pg_dump --format=custom --no-owner --file "$file" "$admin"
echo "backup_finished $file"

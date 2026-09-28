# Backup and recovery

PostgreSQL is the source of truth. Redis is not used. Offline IndexedDB and AI drafts are not the books.

## Backup

`scripts/backup-database.sh` runs `pg_dump --format=custom` using `DATABASE_ADMIN_URL`. It refuses a host other than localhost unless `ALLOW_REMOTE_BACKUP=1`. The default directory is `/tmp/dukaanos-backups`, which is outside the git tree and must not be a public web bucket.

The script does not schedule itself. An operator has to run it daily and copy the file to another machine or an encrypted private bucket. This repository does not enable point-in-time recovery. No production database exists yet, so there is no managed backup schedule, off-site copy, or measured production RPO/RTO.

Until that copy exists off the database machine, the only backup is local and the restore point is whenever the script was last run.

## Restore check

`scripts/restore-check.sh /path/to.dump` creates `dukaanos_restore_<timestamp>` on localhost, restores the dump, counts `tenants`, `sales`, and `inventory_balances`, then drops that database. It does not replace the live database.

Record the backup timestamp, restore start, restore finish, and the row counts. A dump that has not been restored this way is not a verified backup.

A local check on 2026-09-28 used `scripts/backup-database.sh` against the development database. The dump was `dukaanos-20260928T053520Z.dump`. Restore into `dukaanos_restore_20260928053521` started at `2026-09-28T05:35:21Z` and finished at `2026-09-28T05:35:22Z`. The restored database opened with 2 tenants, 3 sales, and 1 inventory balance, then the throwaway database was dropped. `scripts/integrity-check.sql` reported 0 negative stock rows and 0 balance mismatches. That dump is on this machine under `/tmp` and is not an off-site production backup.

## Integrity

`scripts/integrity-check.sql` counts negative `inventory_balances.quantity` rows and balances that do not equal the sum of `inventory_movements.quantity_delta`. Run it with `DATABASE_ADMIN_URL` so row-level security does not hide shops. Any non-zero `failures` value needs investigation before calling the data consistent.

## Recovery targets

RPO is the age of the last dump that was copied off the database machine. RTO is the time to restore that dump and start the API. Neither number is a contractual guarantee, and neither is met by a dump that still sits only on the database host.

## Object storage

Intake images stay in a private bucket. Presigned URLs are short-lived. The API deletes abandoned, failed, and confirmed media after `AI_INTAKE_MEDIA_RETENTION_DAYS` (default 30) when that shop next uses intake. Do not put database dumps in that bucket if the bucket policy is broader than the database backup policy.

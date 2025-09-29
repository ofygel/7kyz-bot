#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
pg_dump --no-owner --no-privileges "$DATABASE_URL" > "db/backup_$(date +%F_%H%M).sql"
echo "Backup written to db/backup_$(date +%F_%H%M).sql"

#!/usr/bin/env bash
# Deploy a new version without touching the world.
# Run on the server from the project folder:  ./scripts/deploy.sh
#
# What happens:
#   1. pull the new code
#   2. back up the live world (a consistent copy, taken while it runs) to data/backups/
#   3. restart the service -> old process saves the world on SIGTERM
#   4. new process applies any new migrations (another backup taken first if there are any) and resumes
#
# step 10 (0.5): the live world runs with WORLD_ROLE=live and `npm start` (never `npm run dev`: with WORLD_ROLE=live
# the server refuses to start under --watch). This script is the only way it gets new code.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! grep -qs '^WORLD_ROLE=live' .env; then
  echo "note: .env has no WORLD_ROLE=live; the live world should run with it (see .env.example)" >&2
fi

git pull --ff-only

DATA="${DATA_DIR:-data}"
if [ -f "$DATA/world.db" ]; then
  mkdir -p "$DATA/backups"
  STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  node --disable-warning=ExperimentalWarning -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec(\"VACUUM INTO '\" + process.argv[2].replace(/'/g, \"''\") + \"'\");
    db.close();
  " "$DATA/world.db" "$DATA/backups/${STAMP}_pre-deploy.db"
  echo "backup: $DATA/backups/${STAMP}_pre-deploy.db"
fi

sudo systemctl restart agent-world
sleep 2
systemctl --no-pager --lines=15 status agent-world

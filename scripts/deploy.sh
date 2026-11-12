#!/usr/bin/env bash
# Deploy a new version without touching the world.
# Run on the server from the project folder:  ./scripts/deploy.sh
#
# What happens:
#   1. pull the new code
#   2. restart the service -> old process saves the world on SIGTERM
#   3. new process applies any new migrations (backup taken first) and resumes
set -euo pipefail
cd "$(dirname "$0")/.."

git pull --ff-only
sudo systemctl restart agent-world
sleep 2
systemctl --no-pager --lines=15 status agent-world

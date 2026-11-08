#!/bin/sh
# Mac/Linux deploy. Usage: RIFFBOX_HOST=you@sanjaysubramanian.com sh deploy/deploy.sh
set -eu
: "${RIFFBOX_HOST:?set RIFFBOX_HOST=user@host}"
cd "$(dirname "$0")/.."
tar --exclude='__pycache__' --exclude='.pytest_cache' --exclude='.venv' --exclude='tests' \
    -czf /tmp/riffbox.tgz app static
scp /tmp/riffbox.tgz "$RIFFBOX_HOST":riffbox.tgz
ssh "$RIFFBOX_HOST" 'rm -rf riffbox-incoming && mkdir riffbox-incoming \
  && tar xzf riffbox.tgz -C riffbox-incoming \
  && doas rsync -rlt --delete --chmod=D755,F644 --chown=root:wheel riffbox-incoming/ /usr/local/riffbox/ \
  && doas rcctl restart riffbox'
echo "deployed"

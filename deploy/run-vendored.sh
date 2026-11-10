#!/bin/sh
# Run Riffbox from the vendored copies of Flask, waitress and their helpers (the vendor/ folder), ignoring whatever is
# installed on the machine. For the rehearsal of "can this be rebuilt with only Python and the repository", for a machine where
# the packages are not installed, and as the emergency way to start the app if the installed ones ever break.
#
#   RIFFBOX_DATA_DIR=... RIFFBOX_SECRET=... RIFFBOX_PASSPHRASE=... sh deploy/run-vendored.sh [waitress arguments]
#
# With no arguments it listens on 127.0.0.1:8100 like the service does. Needs only python3.
here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here/app" || exit 1
PYTHONPATH="$here/vendor" exec python3 -m waitress --listen=127.0.0.1:8100 --threads=4 "$@" wsgi:app

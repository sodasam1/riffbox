#!/bin/sh
# Proves the manifest-based installer (deploy/install.sh + appkit.sh) writes the SAME files as the old hand-written installer
# (tests/installer/legacy-install.sh, a frozen copy). Compared: relayd.conf, the service script, the conf file (apart from the two
# random lines), the .pre-riffbox backups and the folders created. Usage: RIFFBOX_TEST_PYTHON=python3 sh tests/installer/test-equivalence.sh
set -eu
cd "$(dirname "$0")/../.."
FIX=$(pwd)/tests/installer/fixtures
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
fail=0; ok() { echo "PASS: $*"; }; bad() { echo "FAIL: $*"; fail=1; }
export DOAS_USER=me RIFFBOX_INSTALL_PASSPHRASE='a long test passphrase' RIFFBOX_INSTALL_TOKEN=tok123
: "${RIFFBOX_TEST_PYTHON:=python3}"; export RIFFBOX_TEST_PYTHON
unset RIFFBOX_TEST_ANSWER
# two upload folders: one with the old installer, one with the new
for v in old new; do mkdir -p "$W/$v-src"; cp -R app static deploy "$W/$v-src/"; find "$W/$v-src" -name __pycache__ -prune -exec rm -rf {} +; done
cp tests/installer/legacy-install.sh "$W/old-src/deploy/install.sh"
OLD="$W/old-src/deploy/install.sh"; NEW="$W/new-src/deploy/install.sh"
norm() { sed -e 's/^RIFFBOX_SECRET=.*/RIFFBOX_SECRET=<random>/' -e 's/^RIFFBOX_PASSPHRASE_HASH=.*/RIFFBOX_PASSPHRASE_HASH=<hash>/' "$1"; }
same() {   # same NAME OLDROOT NEWROOT FILE...
  n=$1; a=$2; b=$3; shift 3
  for f in "$@"; do
    if [ ! -e "$a/$f" ] && [ ! -e "$b/$f" ]; then continue; fi
    if [ -e "$a/$f" ] && [ -e "$b/$f" ] && [ "$(norm "$a/$f")" = "$(norm "$b/$f")" ]; then :; else bad "$n: $f differs between the old and the new installer"; diff "$a/$f" "$b/$f" | head -10; return; fi
  done
  ok "$n: $* are identical"
}
tree() { (cd "$1" && find . -type d | sort); }

# ---- a fresh Tech Independence server, every question answered yes ---------------------------------------------
for v in old new; do mkdir -p "$W/$v-fresh/etc"; cp "$FIX/relayd.pristine.conf" "$W/$v-fresh/etc/relayd.conf"; done
RIFFBOX_TEST_ROOT="$W/old-fresh" sh "$OLD" --yes > /dev/null
RIFFBOX_TEST_ROOT="$W/new-fresh" sh "$NEW" --yes > /dev/null
same "fresh" "$W/old-fresh" "$W/new-fresh" etc/relayd.conf etc/relayd.conf.pre-riffbox etc/rc.d/riffbox etc/riffbox.conf
[ "$(tree "$W/old-fresh")" = "$(tree "$W/new-fresh")" ] && ok "fresh: the same folders are created" || bad "fresh: folder trees differ"

# ---- your live server: rules and script written by hand, plain-text passphrase -----------------------------------
for v in old new; do
  L="$W/$v-live"; mkdir -p "$L/etc/rc.d"; cp "$FIX/relayd.live.conf" "$L/etc/relayd.conf"; sed 's/--threads=4/--threads=8/' "$FIX/rc.d.live" > "$L/etc/rc.d/riffbox"
  printf 'RIFFBOX_SECRET=keep\nRIFFBOX_PASSPHRASE=old plain pass\n' > "$L/etc/riffbox.conf"
done
RIFFBOX_TEST_ROOT="$W/old-live" RIFFBOX_TEST_ANSWER=y sh "$OLD" --repair > /dev/null
RIFFBOX_TEST_ROOT="$W/new-live" RIFFBOX_TEST_ANSWER=y sh "$NEW" --repair > /dev/null
same "live --repair" "$W/old-live" "$W/new-live" etc/relayd.conf etc/rc.d/riffbox etc/rc.d/riffbox.pre-riffbox etc/riffbox.conf
[ "$(tree "$W/old-live")" = "$(tree "$W/new-live")" ] && ok "live --repair: the same folders" || bad "live: folder trees differ"
[ "$fail" = 0 ] && echo "ALL PASSED" || { echo "SOME FAILED"; exit 1; }

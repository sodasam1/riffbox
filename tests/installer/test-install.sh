#!/bin/sh
# Runs deploy/install.sh against copies of REAL config files (no OpenBSD needed). Usage: sh tests/installer/test-install.sh
set -eu
cd "$(dirname "$0")/../.."
SCR=$(pwd)/deploy/install.sh; FIX=$(pwd)/tests/installer/fixtures
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
fail=0
ok()  { echo "PASS: $*"; }
bad() { echo "FAIL: $*"; fail=1; }
export DOAS_USER=me RIFFBOX_INSTALL_PASSPHRASE='a long test passphrase' RIFFBOX_INSTALL_TOKEN=tok123
unset RIFFBOX_TEST_ANSWER
: "${RIFFBOX_TEST_PYTHON:=python3}"; export RIFFBOX_TEST_PYTHON

# --- a fresh Tech Independence server -------------------------------------------------------------
R="$W/fresh"; mkdir -p "$R/etc"; cp "$FIX/relayd.pristine.conf" "$R/etc/relayd.conf"; cp "$R/etc/relayd.conf" "$R/orig"
export RIFFBOX_TEST_ROOT="$R"
# the data volume: nothing is created, and the installer stops, until it is mounted and holds .volume-ok
sh "$SCR" --yes > "$R/refuse.out" 2>&1 && bad "fresh: installer ran without the data volume" || { grep -q 'must be mounted' "$R/refuse.out" && [ ! -e "$R/etc/riffbox.conf" ] && [ ! -e "$R/etc/rc.d/riffbox" ] && [ ! -d "$R/mnt/data/apps/riffbox" ] && ok "fresh: refuses to run when /mnt/data is not mounted, and creates nothing" || bad "fresh: mount guard"; }
mkdir -p "$R/mnt/data"; touch "$R/mnt/data/.volume-ok"
sh "$SCR" --check > "$R/check.out" && cmp -s "$R/orig" "$R/etc/relayd.conf" && [ ! -e "$R/etc/riffbox.conf" ] && [ ! -e "$R/etc/rc.d/riffbox" ] && ok "fresh: --check changes nothing" || bad "fresh: --check wrote something"
grep -q 'WILL CREATE' "$R/check.out" && grep -q 'WILL CHANGE' "$R/check.out" && grep -q '^Summary:' "$R/check.out" && ok "fresh: --check lists what it would create and change" || bad "fresh: --check summary"
sh "$SCR" > "$R/run0.out"        # no --yes, no answer: new things are created, the existing relayd.conf is NOT changed
[ -f "$R/etc/rc.d/riffbox" ] && [ -f "$R/etc/riffbox.conf" ] && ok "fresh: new files are created without asking" || bad "fresh: creation"
cmp -s "$R/orig" "$R/etc/relayd.conf" && grep -q 'NOT CHANGED' "$R/run0.out" && ok "fresh: relayd.conf is not changed without a yes (and says so)" || bad "fresh: relayd changed without consent"
sh "$SCR" --yes > "$R/run1.out" || { bad "fresh: --yes run failed"; cat "$R/run1.out"; }
for need in '<riffbox> { 127.0.0.1 }' 'path "/ideas" forward to <riffbox>' 'path "/ideas/\*" forward to <riffbox>' 'forward to <riffbox> port 8100'; do
  [ "$(grep -c "$need" "$R/etc/relayd.conf")" = 1 ] && ok "fresh: relayd has exactly one: $need" || bad "fresh: relayd rule count: $need"
done
diff "$R/orig" "$R/etc/relayd.conf" | grep '^<' >/dev/null && bad "fresh: an original relayd line changed" || ok "fresh: relayd edit is additions only"
awk '/path "\/ideas\/\*"/{a=NR} /quick header "Host"/&&!h{h=NR} END{exit !(a&&h&&a<h)}' "$R/etc/relayd.conf" && ok "fresh: path rules sit before the Host rules" || bad "fresh: rule order"
[ -f "$R/etc/relayd.conf.pre-riffbox" ] && cmp -s "$R/etc/relayd.conf.pre-riffbox" "$R/orig" && ok "fresh: backup equals original" || bad "fresh: backup"
grep -q '^RIFFBOX_PASSPHRASE_HASH=' "$R/etc/riffbox.conf" && ! grep -q 'long test passphrase\|^RIFFBOX_PASSPHRASE=' "$R/etc/riffbox.conf" && ok "fresh: passphrase stored only as a hash" || bad "fresh: hash"
grep -q '^RIFFBOX_BACKUP_DIR=/mnt/data/apps/riffbox/backup$' "$R/etc/riffbox.conf" && ! grep -qi crontab "$R/run1.out" && ok "fresh: backup folder is set for the Back up now button, and no cron job is mentioned or added" || bad "fresh: backup setting / cron"
grep -q '^RIFFBOX_DATA_DIR=/mnt/data/apps/riffbox/data$' "$R/etc/riffbox.conf" && grep -q '^RIFFBOX_RESTORE_DIR=/mnt/data/apps/riffbox/restore$' "$R/etc/riffbox.conf" && ok "fresh: data, backup and restore folders are all on the volume" || bad "fresh: data/restore settings"
[ -d "$R/mnt/data/apps/riffbox/data" ] && [ -d "$R/mnt/data/apps/riffbox/backup" ] && [ -d "$R/mnt/data/apps/riffbox/restore" ] && [ ! -d "$R/var/riffbox" ] && ok "fresh: the folders are created on the volume, none on the boot disk" || bad "fresh: folders"
grep -q '^rc_pre() {$' "$R/etc/rc.d/riffbox" && grep -q ' on /mnt/data type ' "$R/etc/rc.d/riffbox" && ok "fresh: the service refuses to start unless /mnt/data is mounted and holds .volume-ok" || bad "fresh: rc_pre guard"
grep -q '^RIFFBOX_UPLOAD_TOKEN=tok123$' "$R/etc/riffbox.conf" && ok "fresh: existing phone token reused" || bad "fresh: token"
[ "$(stat -c %a "$R/etc/riffbox.conf")" = 640 ] && ok "fresh: riffbox.conf mode 640" || bad "fresh: conf mode"
cp "$R/etc/relayd.conf" "$R/a1"; cp "$R/etc/riffbox.conf" "$R/c1"; cp "$R/etc/rc.d/riffbox" "$R/r1"; sh "$SCR" --yes >/dev/null
cmp -s "$R/a1" "$R/etc/relayd.conf" && cmp -s "$R/c1" "$R/etc/riffbox.conf" && cmp -s "$R/r1" "$R/etc/rc.d/riffbox" && ok "fresh: second run changes nothing" || bad "fresh: not idempotent"

# --- --app-files-only on an empty server touches no system file -----------------------------------------
C="$W/codeonly"; mkdir -p "$C/etc"; cp "$FIX/relayd.pristine.conf" "$C/etc/relayd.conf"
RIFFBOX_TEST_ROOT="$C" sh "$SCR" --app-files-only --yes > "$C/out" && [ ! -e "$C/etc/riffbox.conf" ] && [ ! -e "$C/etc/rc.d/riffbox" ] && cmp -s "$FIX/relayd.pristine.conf" "$C/etc/relayd.conf" && ok "app-files-only: no config, service script or relayd change" || bad "app-files-only touched system files"
grep -q 'rsync' "$C/out" && ! grep -q 'groupadd\|pkg_add\|crontab' "$C/out" && ok "app-files-only: only the code copy (no packages, user or cron)" || bad "app-files-only: extra steps ran"

# --- your live server: everything already set up by hand ----------------------------------------------
L="$W/live"; mkdir -p "$L/etc/rc.d" "$L/mnt/data"; touch "$L/mnt/data/.volume-ok"; cp "$FIX/relayd.live.conf" "$L/etc/relayd.conf"
# the same service script with the start guard the installer now writes (as it would be after one --repair)
printf 'rc_pre() {\n\tmount | grep -q " on /mnt/data type " && [ -f "/mnt/data/.volume-ok" ] || {\n\t\techo "/mnt/data is not mounted, or /mnt/data/.volume-ok is missing: not starting riffbox" >&2\n\t\treturn 1\n\t}\n}\n\n' > "$W/guard"
awk -v g="$W/guard" '/^rc_cmd/{while((getline l < g)>0) print l} {print}' "$FIX/rc.d.live" > "$W/rc.d.live.guarded"
cp "$W/rc.d.live.guarded" "$L/etc/rc.d/riffbox"
printf 'RIFFBOX_SECRET=keep\nRIFFBOX_PASSPHRASE=old plain pass\n' > "$L/etc/riffbox.conf"
for f in relayd.conf riffbox.conf rc.d/riffbox; do cp "$L/etc/$f" "$L/orig-$(echo $f | tr / _)"; done
export RIFFBOX_TEST_ROOT="$L"
RIFFBOX_TEST_ANSWER=y sh "$SCR" > "$L/out"
same=1; for f in relayd.conf riffbox.conf rc.d/riffbox; do cmp -s "$L/etc/$f" "$L/orig-$(echo $f | tr / _)" || same=0; done
[ "$same" = 1 ] && ok "live: relayd.conf, riffbox.conf and the service script are byte-for-byte untouched" || bad "live: something was changed"
grep -q 'same settings (comments may differ)' "$L/out" && ok "live: the service script's comment-only difference is recognised" || bad "live: rc.d comparison"

# the service script written before the volume existed (no start guard): reported by default; --repair adds the guard and keeps the old one
cp "$FIX/rc.d.live" "$L/etc/rc.d/riffbox"; cp "$L/etc/rc.d/riffbox" "$L/noguard"
sh "$SCR" > "$L/o1b"; cmp -s "$L/noguard" "$L/etc/rc.d/riffbox" && grep -q 'differs in its settings' "$L/o1b" && ok "live: a script without the start guard is reported and left alone by default" || bad "live: guard-less script handling"
RIFFBOX_TEST_ANSWER=y sh "$SCR" --repair > "$L/o1c"; grep -q '^rc_pre() {$' "$L/etc/rc.d/riffbox" && cmp -s "$L/noguard" "$L/etc/rc.d/riffbox.pre-riffbox" && ok "live: --repair adds the start guard and keeps the old script as .pre-riffbox" || bad "live: guard repair"
rm -f "$L/etc/rc.d/riffbox.pre-riffbox"; cp "$W/rc.d.live.guarded" "$L/etc/rc.d/riffbox"

# a service script whose SETTINGS differ
sed 's/--threads=4/--threads=8/' "$FIX/rc.d.live" > "$L/etc/rc.d/riffbox"; cp "$L/etc/rc.d/riffbox" "$L/modified"
sh "$SCR" > "$L/o2"; cmp -s "$L/modified" "$L/etc/rc.d/riffbox" && grep -q 'use --repair' "$L/o2" && ok "live: a really different script is reported, not changed, by default" || bad "live: default changed rc.d"
RIFFBOX_TEST_ANSWER=n sh "$SCR" --repair > "$L/o3"; cmp -s "$L/modified" "$L/etc/rc.d/riffbox" && ok "live: --repair does nothing if you answer no" || bad "live: repair ignored the answer"
RIFFBOX_TEST_ANSWER=y sh "$SCR" --repair > "$L/o4"
grep -q -- '--threads=4' "$L/etc/rc.d/riffbox" && cmp -s "$L/modified" "$L/etc/rc.d/riffbox.pre-riffbox" && ok "live: --repair with yes replaces it and keeps the old one as .pre-riffbox" || bad "live: repair result"

# a live riffbox.conf with no backup-folder line: reported by default; --repair + yes appends the line and keeps everything else
cp "$L/orig-riffbox.conf" "$L/etc/riffbox.conf"
sh "$SCR" > "$L/out5"; cmp -s "$L/etc/riffbox.conf" "$L/orig-riffbox.conf" && grep -q 'Back up now' "$L/out5" && ok "live: a missing backup-folder setting is reported and left alone by default" || bad "live: default changed conf"
RIFFBOX_TEST_ANSWER=n sh "$SCR" --repair >/dev/null; cmp -s "$L/etc/riffbox.conf" "$L/orig-riffbox.conf" && ok "live: --repair does nothing if you answer no" || bad "live: repaired without consent"
RIFFBOX_TEST_ANSWER=y sh "$SCR" --repair >/dev/null
[ "$(grep -c '^RIFFBOX_BACKUP_DIR=/mnt/data/apps/riffbox/backup$' "$L/etc/riffbox.conf")" = 1 ] && grep -q '^RIFFBOX_RESTORE_DIR=/mnt/data/apps/riffbox/restore$' "$L/etc/riffbox.conf" && ! grep -q '^RIFFBOX_DATA_DIR=' "$L/etc/riffbox.conf" && grep -q '^RIFFBOX_SECRET=keep$' "$L/etc/riffbox.conf" && ok "live: --repair with yes adds the one line and keeps the rest" || bad "live: backup line"
cp "$L/etc/riffbox.conf" "$L/c3"; RIFFBOX_TEST_ANSWER=y sh "$SCR" --repair >/dev/null; cmp -s "$L/c3" "$L/etc/riffbox.conf" && ok "live: a second --repair adds nothing more" || bad "live: duplicated line"

# an old conf that points at the boot disk: reported; the data setting is only changed once the data has been copied
printf 'RIFFBOX_SECRET=keep\nRIFFBOX_DATA_DIR=/var/riffbox\nRIFFBOX_BACKUP_DIR=/var/riffbox-backup\nRIFFBOX_RESTORE_DIR=/var/riffbox-restore\nRIFFBOX_UPLOAD_TOKEN=t\n' > "$L/etc/riffbox.conf"; cp "$L/etc/riffbox.conf" "$L/oldpaths"
sh "$SCR" > "$L/o7"; cmp -s "$L/etc/riffbox.conf" "$L/oldpaths" && grep -q 'belongs on the volume' "$L/o7" && ok "live: a conf that points at the boot disk is reported and left alone by default" || bad "live: old-path conf changed by default"
RIFFBOX_TEST_ANSWER=y sh "$SCR" --repair > "$L/o8"
grep -q '^RIFFBOX_DATA_DIR=/var/riffbox$' "$L/etc/riffbox.conf" && grep -q 'copy the data first' "$L/o8" && ok "live: --repair does not repoint the data folder until the data has been copied" || bad "live: data repointed before copy"
grep -q '^RIFFBOX_BACKUP_DIR=/mnt/data/apps/riffbox/backup$' "$L/etc/riffbox.conf" && grep -q '^RIFFBOX_RESTORE_DIR=/mnt/data/apps/riffbox/restore$' "$L/etc/riffbox.conf" && grep -q '^RIFFBOX_UPLOAD_TOKEN=t$' "$L/etc/riffbox.conf" && ok "live: --repair + yes repoints the backup and restore folders and keeps every other line" || bad "live: backup/restore repoint"
touch "$L/mnt/data/apps/riffbox/data/riffbox.db"; RIFFBOX_TEST_ANSWER=y sh "$SCR" --repair > "$L/o9"
grep -q '^RIFFBOX_DATA_DIR=/mnt/data/apps/riffbox/data$' "$L/etc/riffbox.conf" && [ "$(grep -c '^RIFFBOX_DATA_DIR=' "$L/etc/riffbox.conf")" = 1 ] && ok "live: once riffbox.db is on the volume, --repair + yes repoints the data folder (one line, no duplicate)" || bad "live: data repoint"
cp "$L/etc/riffbox.conf" "$L/c4"; RIFFBOX_TEST_ANSWER=y sh "$SCR" --repair >/dev/null; cmp -s "$L/c4" "$L/etc/riffbox.conf" && ok "live: a second --repair changes nothing" || bad "live: repair not idempotent"

# the plain-text passphrase on a live server: reported by default, converted only with --repair and a yes
cp "$L/orig-riffbox.conf" "$L/etc/riffbox.conf"
sh "$SCR" > "$L/out6"
cmp -s "$L/etc/riffbox.conf" "$L/orig-riffbox.conf" && grep -q 'plain text' "$L/out6" && ok "live: plain-text passphrase is reported and left alone by default" || bad "live: default touched riffbox.conf"
RIFFBOX_TEST_ANSWER=n sh "$SCR" --repair >/dev/null; cmp -s "$L/etc/riffbox.conf" "$L/orig-riffbox.conf" && ok "live: --repair does nothing to the passphrase if you answer no" || bad "live: converted without consent"
RIFFBOX_TEST_ANSWER=y sh "$SCR" --repair >/dev/null
grep -q '^RIFFBOX_PASSPHRASE_HASH=' "$L/etc/riffbox.conf" && ! grep -q 'old plain pass\|^RIFFBOX_PASSPHRASE=' "$L/etc/riffbox.conf" && grep -q '^RIFFBOX_SECRET=keep$' "$L/etc/riffbox.conf" && ok "live: --repair with yes converts the passphrase and keeps the other settings" || bad "live: conversion"
cp "$L/etc/riffbox.conf" "$L/c2"; RIFFBOX_TEST_ANSWER=y sh "$SCR" --repair >/dev/null; cmp -s "$L/c2" "$L/etc/riffbox.conf" && ok "live: a second --repair leaves the converted file alone" || bad "live: second repair changed it"

# --- the uploaded folder stays clean: running the installer and the tools must not leave __pycache__ folders in it (as root they could not be deleted again)
K="$W/upload"; mkdir -p "$K/etc" "$K/mnt/data"; touch "$K/mnt/data/.volume-ok"; cp "$FIX/relayd.pristine.conf" "$K/etc/relayd.conf"
mkdir -p "$W/src"; cp -R app static deploy "$W/src/"; find "$W/src" -name __pycache__ -prune -exec rm -rf {} +
RIFFBOX_TEST_ROOT="$K" sh "$W/src/deploy/install.sh" --yes >/dev/null
printf 'a long test passphrase\n' | "$RIFFBOX_TEST_PYTHON" "$W/src/deploy/hash_passphrase.py" >/dev/null
"$RIFFBOX_TEST_PYTHON" "$W/src/deploy/hash_passphrase.py" --method >/dev/null
[ -z "$(find "$W/src" -name __pycache__)" ] && ok "upload folder: the installer and tools leave no __pycache__ behind" || bad "upload folder: __pycache__ was created"
[ "$fail" = 0 ] && echo "ALL PASSED" || { echo "SOME FAILED"; exit 1; }

#!/bin/sh
# Runs deploy/install.sh against copies of REAL relayd.conf files (no OpenBSD needed). Usage: sh tests/installer/test-install.sh
set -eu
cd "$(dirname "$0")/../.."
SCR=$(pwd)/deploy/install.sh; FIX=$(pwd)/tests/installer/fixtures
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
fail=0
ok()  { echo "PASS: $*"; }
bad() { echo "FAIL: $*"; fail=1; }
export DOAS_USER=me RIFFBOX_INSTALL_PASSPHRASE=test-pass RIFFBOX_INSTALL_TOKEN=tok123

# --- a fresh Tech Independence server -------------------------------------------------------------
R="$W/fresh"; mkdir -p "$R/etc"; cp "$FIX/relayd.pristine.conf" "$R/etc/relayd.conf"; cp "$R/etc/relayd.conf" "$R/orig"
export RIFFBOX_TEST_ROOT="$R"
sh "$SCR" --check > "$R/check.out" && cmp -s "$R/orig" "$R/etc/relayd.conf" && [ ! -e "$R/etc/riffbox.conf" ] && [ ! -e "$R/etc/rc.d/riffbox" ] && ok "fresh: --check changes nothing" || bad "fresh: --check wrote something"
sh "$SCR" > "$R/run1.out" || { bad "fresh: first run failed"; cat "$R/run1.out"; }
for need in '<riffbox> { 127.0.0.1 }' 'path "/ideas" forward to <riffbox>' 'path "/ideas/\*" forward to <riffbox>' 'forward to <riffbox> port 8100'; do
  [ "$(grep -c "$need" "$R/etc/relayd.conf")" = 1 ] && ok "fresh: relayd has exactly one: $need" || bad "fresh: relayd rule count: $need"
done
diff "$R/orig" "$R/etc/relayd.conf" | grep '^<' >/dev/null && bad "fresh: an original relayd line changed" || ok "fresh: relayd edit is additions only"
# order: both path rules must come before the first Host rule
awk '/path "\/ideas\/\*"/{a=NR} /quick header "Host"/&&!h{h=NR} END{exit !(a&&h&&a<h)}' "$R/etc/relayd.conf" && ok "fresh: path rules sit before the Host rules" || bad "fresh: rule order"
[ -f "$R/etc/relayd.conf.pre-riffbox" ] && cmp -s "$R/etc/relayd.conf.pre-riffbox" "$R/orig" && ok "fresh: backup equals original" || bad "fresh: backup"
grep -q '^RIFFBOX_UPLOAD_TOKEN=tok123$' "$R/etc/riffbox.conf" && ok "fresh: existing phone token reused" || bad "fresh: token"
[ "$(stat -c %a "$R/etc/riffbox.conf")" = 640 ] && ok "fresh: riffbox.conf mode 640" || bad "fresh: conf mode"
grep -qE '^RIFFBOX_SECRET=[0-9a-f]{64}$' "$R/etc/riffbox.conf" && ok "fresh: 64-hex session secret generated" || bad "fresh: secret"
cp "$R/etc/relayd.conf" "$R/a1"; cp "$R/etc/riffbox.conf" "$R/c1"; sh "$SCR" >/dev/null
cmp -s "$R/a1" "$R/etc/relayd.conf" && cmp -s "$R/c1" "$R/etc/riffbox.conf" && ok "fresh: second run changes nothing (secrets kept)" || bad "fresh: not idempotent"

# --- your live server (Riffbox rules already in relayd.conf, written by hand) -----------------------
L="$W/live"; mkdir -p "$L/etc"; cp "$FIX/relayd.live.conf" "$L/etc/relayd.conf"; cp "$L/etc/relayd.conf" "$L/orig"
export RIFFBOX_TEST_ROOT="$L"; printf 'RIFFBOX_SECRET=keep\n' > "$L/etc/riffbox.conf"
sh "$SCR" >/dev/null; cmp -s "$L/orig" "$L/etc/relayd.conf" && ok "live: hand-written relayd rules left untouched" || bad "live: relayd changed"
grep -q '^RIFFBOX_SECRET=keep$' "$L/etc/riffbox.conf" && [ "$(wc -l < "$L/etc/riffbox.conf")" = 1 ] && ok "live: existing riffbox.conf never overwritten" || bad "live: conf overwritten"
[ "$fail" = 0 ] && echo "ALL PASSED" || { echo "SOME FAILED"; exit 1; }

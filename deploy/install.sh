#!/bin/sh
# Riffbox: one-file installer for an OpenBSD server built with Tech Independence.
#
#   doas sh ~/riffbox/deploy/install.sh --check    show everything it would do; change nothing
#   doas sh ~/riffbox/deploy/install.sh            do it (safe to run again: only differences are applied)
#
# Run it from the Riffbox folder you uploaded (the one that contains app/, static/ and deploy/).
# It needs only tools that ship with OpenBSD or that Tech Independence installs (sh, awk, rsync, openssl,
# pkg_add, rcctl, relayd, crontab). It never touches httpd, pf, mail, Radicale or DNS, and never overwrites
# an existing /etc/riffbox.conf (that file holds your passphrase and tokens).
# The same steps, by hand, are in deploy/INSTALL.md, so you are never dependent on this script.
#
# Test hook: RIFFBOX_TEST_ROOT=/some/dir applies file edits under that folder and only PRINTS the system commands.
set -eu

ROOT="${RIFFBOX_TEST_ROOT:-}"
SRC=$(cd "$(dirname "$0")/.." && pwd)
RELAYD_CONF="$ROOT/etc/relayd.conf"
CONF="$ROOT/etc/riffbox.conf"
RCD="$ROOT/etc/rc.d/riffbox"
CODE="$ROOT/usr/local/riffbox"
DATA="$ROOT/var/riffbox"
BACKUP="$ROOT/var/riffbox-backup"
RESTORE="$ROOT/var/riffbox-restore"
CHECK=0
case "${1:-}" in
  "") ;;
  --check) CHECK=1 ;;
  *) echo "usage: $0 [--check]"; exit 2 ;;
esac

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
# write-type commands: run for real only on a real server and not in --check
run()  { if [ "$CHECK" = 1 ] || [ -n "$ROOT" ]; then say "   [would run] $*"; else "$@"; fi; }
# file edits: done unless --check
edit_ok() { [ "$CHECK" = 0 ]; }

TMP=$(mktemp); NEW=$(mktemp)
trap 'rm -f "$TMP" "$NEW"' EXIT
CHANGED=0

if [ -z "$ROOT" ]; then
  [ "$(id -u)" -eq 0 ] || { say "Run this with doas (it needs root)."; exit 1; }
  [ "$(uname)" = OpenBSD ] || { say "This installer is for OpenBSD."; exit 1; }
  [ "$(uname -r)" = "7.9" ] || say "NOTE: tested on OpenBSD 7.9; this is $(uname -r). Read each step before agreeing."
fi
[ -f "$SRC/app/wsgi.py" ] && [ -d "$SRC/static" ] || { say "Run this from the uploaded riffbox folder (app/ and static/ not found next to deploy/)."; exit 1; }

PY="${RIFFBOX_TEST_PYTHON:-$(command -v python3 2>/dev/null || echo /usr/local/bin/python3)}"
LOGIN_USER="${DOAS_USER:-${SUDO_USER:-}}"
if [ -z "$LOGIN_USER" ]; then printf 'Your login name on this server: '; read -r LOGIN_USER; fi

# ---- 1. packages ---------------------------------------------------------------------------------
step "1. Riffbox's packages (py3-flask, py3-waitress, ffmpeg)"
missing=""
for p in py3-flask py3-waitress ffmpeg; do
  if [ -z "$ROOT" ] && ! pkg_info -q 2>/dev/null | grep -q "^$p-"; then missing="$missing $p"; fi
done
if [ -n "$missing" ]; then say "   missing:$missing"; run pkg_add $missing; else say "   already installed (or test mode)"; fi

# ---- 2. service user, folders --------------------------------------------------------------------
step "2. Service user and folders"
if [ -n "$ROOT" ] || ! id _riffbox >/dev/null 2>&1; then
  run groupadd _riffbox
  run useradd -g _riffbox -L daemon -s /sbin/nologin -d /var/riffbox -c "Riffbox" _riffbox
else say "   user _riffbox exists"; fi
run install -d -o root -g wheel -m 755 /usr/local/riffbox
run install -d -o _riffbox -g _riffbox -m 750 /var/riffbox
run install -d -o _riffbox -g _riffbox -m 755 /var/riffbox-backup
run install -d -o "$LOGIN_USER" -g "$LOGIN_USER" -m 755 /var/riffbox-restore
if edit_ok && [ -n "$ROOT" ]; then mkdir -p "$CODE" "$DATA" "$BACKUP" "$RESTORE"; fi

# ---- 3. code -------------------------------------------------------------------------------------
step "3. Riffbox code to /usr/local/riffbox"
RS="-rlt --delete --itemize-changes --chmod=D755,F644 --chown=root:wheel --exclude=__pycache__ --exclude=.pytest_cache --exclude=.venv --exclude=tests --exclude=docs"
if [ -z "$ROOT" ]; then
  if [ "$CHECK" = 1 ]; then n=$(rsync $RS -n "$SRC/app" "$SRC/static" "$SRC/deploy" /usr/local/riffbox/ | wc -l)
  else n=$(rsync $RS "$SRC/app" "$SRC/static" "$SRC/deploy" /usr/local/riffbox/ | wc -l); fi
  say "   $n file change(s)"; [ "$n" -eq 0 ] || CHANGED=1
else say "   [would run] rsync $RS app static deploy -> /usr/local/riffbox/"; fi

# ---- 4. rc.d script ------------------------------------------------------------------------------
step "4. Service script /etc/rc.d/riffbox"
cat > "$TMP" <<'RCEOF'
#!/bin/ksh
# OpenBSD rc.d script for Riffbox (written by deploy/install.sh).

daemon="/usr/local/bin/python3"
daemon_flags="-m waitress --listen=127.0.0.1:8100 --threads=4 wsgi:app"
daemon_user="_riffbox"
daemon_execdir="/usr/local/riffbox/app"
daemon_logger="daemon.info"

. /etc/rc.d/rc.subr

rc_bg=YES
rc_reload=NO

rc_cmd $1
RCEOF
if [ -f "$RCD" ] && cmp -s "$RCD" "$TMP"; then say "   up to date"
else
  say "   will write $RCD"
  if edit_ok; then mkdir -p "$(dirname "$RCD")"; cp "$TMP" "$RCD"; run chown root:bin /etc/rc.d/riffbox; chmod 555 "$RCD"; CHANGED=1; fi
fi

# ---- 5. /etc/riffbox.conf (secrets; never overwritten) -------------------------------------------
step "5. Settings and secrets /etc/riffbox.conf"
if [ -f "$CONF" ]; then
  if grep -q '^RIFFBOX_PASSPHRASE=' "$CONF"; then
    say "   exists, with the passphrase stored as plain text: will replace that one line with a salted hash (your login stays the same; everything else is kept)"
    if edit_ok; then "$PY" "$SRC/deploy/hash_passphrase.py" --upgrade-conf "$CONF"; CHANGED=1; fi
  else say "   exists: left exactly as it is"; fi
else
  say "   will create it (mode 640, root:_riffbox)"
  if edit_ok; then
    PASS="${RIFFBOX_INSTALL_PASSPHRASE:-}"; TOK="${RIFFBOX_INSTALL_TOKEN:-}"
    if [ -z "$PASS" ]; then
      say "   Choose a long random passphrase (20+ characters) for the Riffbox login."
      printf '   Passphrase: '; stty -echo 2>/dev/null || true; read -r PASS; stty echo 2>/dev/null || true; echo
    fi
    if [ -z "$TOK" ]; then
      printf '   Paste your EXISTING phone upload token (so the iPhone Shortcut keeps working), or press Enter for a new one: '
      read -r TOK
      [ -n "$TOK" ] || { TOK=$(openssl rand -hex 32); say "   NEW token (put it in your Shortcut and password manager): $TOK"; }
    fi
    HASH=$(printf '%s\n' "$PASS" | "$PY" "$SRC/deploy/hash_passphrase.py") || { say "   Could not hash the passphrase (needs at least 12 characters)."; exit 1; }
    say "   passphrase stored only as a salted hash ($("$PY" "$SRC/deploy/hash_passphrase.py" --method | cut -d: -f1))"
    mkdir -p "$(dirname "$CONF")"
    ( umask 077; cat > "$CONF" <<CONFEOF
# /etc/riffbox.conf (written by deploy/install.sh). Owner root, group _riffbox, mode 640. Real environment variables win over this file.
RIFFBOX_DATA_DIR=/var/riffbox
RIFFBOX_BASE_PATH=/ideas
RIFFBOX_STATIC_DIR=/usr/local/riffbox/static
RIFFBOX_BACKUP_DIR=/var/riffbox-backup
RIFFBOX_SECRET=$(openssl rand -hex 32)
RIFFBOX_UPLOAD_TOKEN=$TOK
RIFFBOX_PASSPHRASE_HASH=$HASH
CONFEOF
    )
    run chown root:_riffbox /etc/riffbox.conf; chmod 640 "$CONF"; CHANGED=1
  fi
fi

# ---- 6. relayd: send /ideas to Riffbox -----------------------------------------------------------
step "6. relayd routes for /ideas"
# remove any block this installer wrote before, then see whether Riffbox rules exist that someone else wrote
awk '$0=="# BEGIN riffbox"{s=1;next} $0=="# END riffbox"{s=0;next} !s' "$RELAYD_CONF" > "$TMP"
if grep -q '<riffbox>' "$TMP"; then
  say "   relayd.conf already has Riffbox rules that this installer did not write: left exactly as they are"
else
  # three insertions: the backend table, the path rules (before the first Host rule, because the first "quick" match wins),
  # and the relay's forward line
  awk '
    /^  pass request quick header "Host"/ && !p {
      print "  # BEGIN riffbox"
      print "  pass request quick path \"/ideas\" forward to <riffbox>"
      print "  pass request quick path \"/ideas/*\" forward to <riffbox>"
      print "  # END riffbox"; p = 1 }
    { print }
    /^table <radicale>/ && !t { print "# BEGIN riffbox"; print "table <riffbox> { 127.0.0.1 }"; print "# END riffbox"; t = 1 }
    /forward to <radicale> port 5232/ && !f { print "  # BEGIN riffbox"; print "  forward to <riffbox> port 8100"; print "  # END riffbox"; f = 1 }
  ' "$TMP" > "$NEW"
  for need in 'table <riffbox>' 'path "/ideas/\*" forward to <riffbox>' 'forward to <riffbox> port 8100'; do
    grep -q "$need" "$NEW" || { say "   could not find where to put: $need (is relayd.conf the Tech Independence one?) Nothing changed."; exit 1; }
  done
  if cmp -s "$RELAYD_CONF" "$NEW"; then say "   up to date"
  else
    say "   relayd.conf would change:"; diff -u "$RELAYD_CONF" "$NEW" | sed 's/^/   /' || true
    if edit_ok; then
      [ -f "$RELAYD_CONF.pre-riffbox" ] || { cp -p "$RELAYD_CONF" "$RELAYD_CONF.pre-riffbox"; say "   backup: $RELAYD_CONF.pre-riffbox"; }
      if [ -z "$ROOT" ]; then relayd -n -f "$NEW" || { say "   relayd rejected the new file: nothing was changed."; exit 1; }; fi
      cp "$NEW" "$RELAYD_CONF"; run rcctl reload relayd
    fi
  fi
fi

# ---- 7. nightly backup ---------------------------------------------------------------------------
step "7. Nightly backup (03:30) of the database and audio"
JOB="30 3 * * * $PY /usr/local/riffbox/deploy/backup.py /var/riffbox /var/riffbox-backup > /dev/null; chown -R _riffbox:_riffbox /var/riffbox-backup # riffbox-backup"
if [ -z "$ROOT" ]; then
  crontab -l 2>/dev/null | grep -v '# riffbox-backup' > "$TMP" || true
  if crontab -l 2>/dev/null | grep -qF "$JOB"; then say "   already scheduled"
  else
    say "   will add to root's crontab: $JOB"
    if edit_ok; then printf '%s\n' "$JOB" >> "$TMP"; crontab "$TMP"; fi
  fi
else say "   [would add to root's crontab] $JOB"; fi

# ---- 8. start ------------------------------------------------------------------------------------
step "8. Start the service"
run rcctl enable riffbox
if [ "$CHANGED" = 1 ]; then run rcctl restart riffbox
elif [ -z "$ROOT" ]; then rcctl check riffbox >/dev/null 2>&1 || run rcctl start riffbox; fi

step "9. Check"
if [ -z "$ROOT" ] && [ "$CHECK" = 0 ]; then
  i=0; ok=0
  while [ "$i" -lt 15 ]; do
    if curl -s http://127.0.0.1:8100/ideas/health | grep -q '"ok"'; then ok=1; break; fi
    i=$((i+1)); sleep 1
  done
  [ "$ok" = 1 ] && say "   PASS: Riffbox answers on 127.0.0.1:8100" || say "   FAIL: no answer from Riffbox; see: tail /var/log/daemon"
else say "   (skipped in --check / test mode)"; fi
[ "$CHECK" = 1 ] && say "\n(--check: nothing was changed)"
exit 0

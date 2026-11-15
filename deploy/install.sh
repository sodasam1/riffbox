#!/bin/sh
# Riffbox: one-file installer for an OpenBSD server built with Tech Independence.
#
#   doas sh ~/riffbox/deploy/install.sh --check       show what it would do; change nothing
#   doas sh ~/riffbox/deploy/install.sh               create what is MISSING; leave everything that already exists alone
#   doas sh ~/riffbox/deploy/install.sh --repair      also fix what exists but is wrong (shows each change, asks first)
#   doas sh ~/riffbox/deploy/install.sh --app-files-only   only copy the app code into place and restart (touches no system file)
#   add --yes to answer "yes" to every question
#
# Run it from the Riffbox folder you uploaded (the one that contains app/, static/ and deploy/).
# Rules it follows: new things (users, folders, packages, new files) are created without asking; a change to something that already
# exists (relayd.conf, /etc/rc.d/riffbox, /etc/riffbox.conf) is shown and needs your "y". It never overwrites an existing
# /etc/riffbox.conf (that file holds your secrets) and never touches httpd, pf, mail, Radicale or DNS.
# The same steps, by hand, are in deploy/INSTALL.md, so you are never dependent on this script.
#
# Test hook: RIFFBOX_TEST_ROOT=/some/dir applies file edits under that folder and only PRINTS the system commands.
set -eu

ROOT="${RIFFBOX_TEST_ROOT:-}"
SRC=$(cd "$(dirname "$0")/.." && pwd)
RELAYD_CONF="$ROOT/etc/relayd.conf"
CONF="$ROOT/etc/riffbox.conf"
RCD="$ROOT/etc/rc.d/riffbox"
CHECK=0; REPAIR=0; CODEONLY=0; YES=0
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    --repair) REPAIR=1 ;;
    --app-files-only) CODEONLY=1 ;;
    --yes) YES=1 ;;
    *) echo "usage: $0 [--check] [--repair] [--app-files-only] [--yes]"; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
N_LEFT=0; N_NEW=0; N_CHG=0; N_HELD=0
left() { N_LEFT=$((N_LEFT+1)); say "   [LEFT ALONE] $*"; }
made() { N_NEW=$((N_NEW+1));  say "   [$( [ "$CHECK" = 1 ] && echo WILL CREATE || echo CREATED )] $*"; }
chgd() { N_CHG=$((N_CHG+1));  say "   [$( [ "$CHECK" = 1 ] && echo WILL CHANGE || echo CHANGED )] $*"; }
held() { N_HELD=$((N_HELD+1)); say "   [NOT CHANGED] $*"; }
# system commands: run for real only on a real server and not in --check
run()  { if [ "$CHECK" = 1 ] || [ -n "$ROOT" ]; then say "   [would run] $*"; else "$@"; fi; }
# may a change to something that already exists be applied? (never in --check; --yes answers for you)
ask() {
  [ "$CHECK" = 1 ] && return 1
  [ "$YES" = 1 ] && return 0
  if [ -n "$ROOT" ]; then [ "${RIFFBOX_TEST_ANSWER:-n}" = y ]; return; fi
  printf '   %s [y/N] ' "$1"; a=n; read -r a < /dev/tty || a=n
  [ "$a" = y ] || [ "$a" = Y ]
}
perm_of() { stat -f '%Su:%Sg %Lp' "$1"; }

TMP=$(mktemp); NEW=$(mktemp); CUR=$(mktemp)
trap 'rm -f "$TMP" "$NEW" "$CUR"' EXIT
CHANGED=0

if [ -z "$ROOT" ]; then
  [ "$(id -u)" -eq 0 ] || { say "Run this with doas (it needs root)."; exit 1; }
  [ "$(uname)" = OpenBSD ] || { say "This installer is for OpenBSD."; exit 1; }
  [ "$(uname -r)" = "7.9" ] || say "NOTE: tested on OpenBSD 7.9; this is $(uname -r). Read each step before agreeing."
fi
[ -f "$SRC/app/wsgi.py" ] && [ -d "$SRC/static" ] || { say "Run this from the uploaded riffbox folder (app/ and static/ not found next to deploy/)."; exit 1; }
[ "$CHECK" = 1 ] && say "(--check: nothing will be changed)"
[ "$CODEONLY" = 1 ] && say "(--app-files-only: only the app code and a restart; no system file is touched)"

PY="${RIFFBOX_TEST_PYTHON:-$(command -v python3 2>/dev/null || echo /usr/local/bin/python3)}"
LOGIN_USER="${DOAS_USER:-${SUDO_USER:-}}"
if [ "$CODEONLY" = 0 ] && [ -z "$LOGIN_USER" ]; then printf 'Your login name on this server: '; read -r LOGIN_USER; fi

# ensure_dir PATH OWNER GROUP MODE: create if missing; if it exists, report whether owner/mode are right, fix only with --repair
ensure_dir() {
  d="$ROOT$1"
  if [ ! -d "$d" ]; then
    made "folder $1 ($2:$3 $4)"
    [ "$CHECK" = 1 ] && return 0
    if [ -n "$ROOT" ]; then mkdir -p "$d"; else install -d -o "$2" -g "$3" -m "$4" "$d"; fi
  elif [ -n "$ROOT" ]; then left "folder $1 exists"
  else
    have=$(perm_of "$d"); want="$2:$3 $4"
    if [ "$have" = "$want" ]; then left "folder $1 ($have)"
    elif [ "$REPAIR" = 1 ] && ask "folder $1 is $have but should be $want. Fix it?"; then chgd "folder $1: $have -> $want"; install -d -o "$2" -g "$3" -m "$4" "$d"
    else held "folder $1 is $have, expected $want (use --repair to fix)"; fi
  fi
}

if [ "$CODEONLY" = 0 ]; then
# ---- 1. packages ---------------------------------------------------------------------------------
step "1. Riffbox's packages (py3-flask, py3-waitress, ffmpeg)"
missing=""
for p in py3-flask py3-waitress ffmpeg; do
  if [ -z "$ROOT" ] && ! pkg_info -q 2>/dev/null | grep -q "^$p-"; then missing="$missing $p"; fi
done
if [ -n "$missing" ]; then made "packages:$missing"; run pkg_add $missing; else left "all three already installed (or test mode)"; fi

# ---- 2. service user, folders --------------------------------------------------------------------
step "2. Service user and folders"
if [ -n "$ROOT" ] || ! id _riffbox >/dev/null 2>&1; then
  made "user and group _riffbox"
  run groupadd _riffbox
  run useradd -g _riffbox -L daemon -s /sbin/nologin -d /var/riffbox -c "Riffbox" _riffbox
else left "user _riffbox exists"; fi
ensure_dir /usr/local/riffbox root wheel 755
ensure_dir /var/riffbox _riffbox _riffbox 750
ensure_dir /var/riffbox-backup _riffbox _riffbox 755
ensure_dir /var/riffbox-restore "$LOGIN_USER" "$LOGIN_USER" 755
fi

# ---- 3. code -------------------------------------------------------------------------------------
step "3. Riffbox code to /usr/local/riffbox"
RS="-rlt --delete --itemize-changes --chmod=D755,F644 --chown=root:wheel --exclude=__pycache__ --exclude=.pytest_cache --exclude=.venv --exclude=tests --exclude=docs --exclude=archive"
if [ -z "$ROOT" ]; then
  if [ "$CHECK" = 1 ]; then n=$(rsync $RS -n "$SRC/app" "$SRC/static" "$SRC/deploy" /usr/local/riffbox/ | wc -l)
  else n=$(rsync $RS "$SRC/app" "$SRC/static" "$SRC/deploy" /usr/local/riffbox/ | wc -l); fi
  if [ "$n" -eq 0 ]; then left "code is already up to date"; else chgd "$n file(s) in /usr/local/riffbox"; [ "$CHECK" = 1 ] || CHANGED=1; fi
else say "   [would run] rsync $RS app static deploy -> /usr/local/riffbox/"; fi

if [ "$CODEONLY" = 0 ]; then
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
# "the same script" means the same settings: comments and blank lines (apart from the first line) are ignored
essence() { awk 'NR==1{print; next} /^[ \t]*#/{next} NF' "$1"; }
install_rcd() { mkdir -p "$(dirname "$RCD")"; cp "$TMP" "$RCD"; run chown root:bin /etc/rc.d/riffbox; chmod 555 "$RCD"; CHANGED=1; }
if [ ! -f "$RCD" ]; then
  made "$RCD"; [ "$CHECK" = 1 ] || install_rcd
else
  essence "$RCD" > "$CUR"; essence "$TMP" > "$NEW"
  if cmp -s "$CUR" "$NEW"; then left "$RCD has the same settings (comments may differ)"
  else
    say "   $RCD differs in its settings:"; diff -u "$RCD" "$TMP" | sed 's/^/   /' || true
    if [ "$REPAIR" = 1 ] && ask "Replace it with the version above? (a copy is kept as $RCD.pre-riffbox)"; then
      [ -f "$RCD.pre-riffbox" ] || cp -p "$RCD" "$RCD.pre-riffbox"; chgd "$RCD"; install_rcd
    else held "$RCD left as it is (use --repair to replace it)"; fi
  fi
fi

# ---- 5. /etc/riffbox.conf (secrets; never overwritten) -------------------------------------------
step "5. Settings and secrets /etc/riffbox.conf"
if [ -f "$CONF" ]; then
  if grep -q '^RIFFBOX_PASSPHRASE=' "$CONF"; then
    say "   $CONF stores the passphrase as plain text. It can be replaced by a salted hash (your login stays the same; every other line is kept)."
    if [ "$REPAIR" = 1 ] && ask "Replace the plain-text passphrase with a hash?"; then
      "$PY" "$SRC/deploy/hash_passphrase.py" --upgrade-conf "$CONF"; chgd "$CONF (passphrase is now a hash)"; CHANGED=1
    else held "plain-text passphrase left as it is (use --repair to convert it; the app still accepts it for now)"; fi
  else left "$CONF exists: never overwritten"; fi
  if ! grep -q '^RIFFBOX_BACKUP_DIR=' "$CONF"; then
    say "   $CONF has no RIFFBOX_BACKUP_DIR line, so the Back up now button on the Backup and export page is switched off."
    if [ "$REPAIR" = 1 ] && ask "Add the line RIFFBOX_BACKUP_DIR=/var/riffbox-backup to it?"; then
      printf 'RIFFBOX_BACKUP_DIR=/var/riffbox-backup\n' >> "$CONF"; chgd "$CONF (backup folder setting added)"; CHANGED=1
    else held "no backup folder is set (use --repair to add the line); the Back up now button stays off"; fi
  fi
else
  made "$CONF (mode 640, root:_riffbox)"
  if [ "$CHECK" = 0 ]; then
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
    HASH=$(printf '%s\n' "$PASS" | "$PY" "$SRC/deploy/hash_passphrase.py") || { say "   Could not hash the passphrase (it needs at least 12 characters)."; exit 1; }
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
  left "relayd.conf already has Riffbox rules that this installer did not write: untouched"
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
  if cmp -s "$RELAYD_CONF" "$NEW"; then left "relayd.conf already has the installer's block"
  else
    say "   relayd.conf would change:"; diff -u "$RELAYD_CONF" "$NEW" | sed 's/^/   /' || true
    if ask "Add these Riffbox routes to relayd.conf? (a copy is kept as $RELAYD_CONF.pre-riffbox)"; then
      [ -f "$RELAYD_CONF.pre-riffbox" ] || { cp -p "$RELAYD_CONF" "$RELAYD_CONF.pre-riffbox"; say "   backup: $RELAYD_CONF.pre-riffbox"; }
      if [ -z "$ROOT" ]; then relayd -n -f "$NEW" || { say "   relayd rejected the new file: nothing was changed."; exit 1; }; fi
      cp "$NEW" "$RELAYD_CONF"; chgd "relayd.conf (routes added)"; run rcctl reload relayd
    elif [ "$CHECK" = 1 ]; then chgd "relayd.conf (routes would be added)"
    else held "relayd.conf not changed: Riffbox will not be reachable until the routes are added"; fi
  fi
fi

fi   # end of "not --app-files-only"

# ---- start ---------------------------------------------------------------------------------------
step "Service"
if [ "$CODEONLY" = 0 ]; then
  if [ -z "$ROOT" ] && rcctl ls on 2>/dev/null | grep -qx riffbox; then left "riffbox is already enabled at boot"; else run rcctl enable riffbox; fi
fi
if [ "$CHANGED" = 1 ]; then run rcctl restart riffbox
elif [ -z "$ROOT" ] && [ "$CHECK" = 0 ]; then rcctl check riffbox >/dev/null 2>&1 && say "   running; nothing needed restarting" || run rcctl start riffbox
else say "   (nothing changed, no restart needed)"; fi

step "Check"
if [ -z "$ROOT" ] && [ "$CHECK" = 0 ]; then
  i=0; ok=0
  while [ "$i" -lt 15 ]; do
    if curl -s http://127.0.0.1:8100/ideas/health | grep -q '"ok"'; then ok=1; break; fi
    i=$((i+1)); sleep 1
  done
  [ "$ok" = 1 ] && say "   PASS: Riffbox answers on 127.0.0.1:8100" || say "   FAIL: no answer from Riffbox; see: tail /var/log/daemon"
else say "   (skipped in --check / test mode)"; fi
say ""
say "Summary: $N_LEFT left alone, $N_NEW $( [ "$CHECK" = 1 ] && echo 'to create' || echo created ), $N_CHG $( [ "$CHECK" = 1 ] && echo 'to change' || echo changed ), $N_HELD held back."
[ "$N_HELD" -eq 0 ] || say "Held-back items were NOT changed. Re-run with --repair (or answer y) to apply them."
[ "$CHECK" = 1 ] && say "(--check: nothing was changed)"
exit 0

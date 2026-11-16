#!/bin/sh
# appkit.sh: the generic installer logic shared by every app on this server (POSIX sh, base tools only).
#
# It is VENDORED: kit/sync-into.sh copies this file into each app's deploy/ folder before you upload, so every app folder is
# self-contained and the server never fetches anything. Each app's deploy/install.sh is three lines:
#
#     #!/bin/sh
#     . "$(dirname "$0")/appkit.sh"
#     appkit_main "$@"
#
# and everything that differs between apps lives in deploy/app.manifest (plain KEY=value lines, see kit/appkit/README.md).
#
#   doas sh ~/APP/deploy/install.sh --check            show what it would do; change nothing
#   doas sh ~/APP/deploy/install.sh                    create what is MISSING; leave everything that exists alone
#   doas sh ~/APP/deploy/install.sh --repair           also fix what exists but is wrong (shows each change, asks first)
#   doas sh ~/APP/deploy/install.sh --app-files-only   only copy the app code into place and restart (no system file touched)
#   add --yes to answer "yes" to every question
#
# Rules (Tech Independence): new things are created without asking; a change to something that already exists (relayd.conf, an rc.d
# script, a conf file) is shown and needs your "y"; it never overwrites an existing conf file (secrets), never deletes data, and never
# touches httpd, pf, mail, DNS or another app's lines. Test hook: APPKIT_TEST_ROOT=dir applies file edits under that folder and only
# PRINTS the system commands (APPKIT_TEST_ANSWER=y stands in for answering "y").

appkit_main() {
set -eu
# Python must not leave root-owned __pycache__ folders in the uploaded folder (FreeFileSync could never delete them).
export PYTHONDONTWRITEBYTECODE=1

ROOT="${APPKIT_TEST_ROOT:-}"
DEPLOY=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "$DEPLOY/.." && pwd)
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
die()  { say "STOP: $*"; exit 1; }

# ---- the manifest: the only place where apps differ ---------------------------------------------------------
[ -f "$DEPLOY/app.manifest" ] || die "no app.manifest next to install.sh"
. "$DEPLOY/app.manifest"
[ -f "$DEPLOY/hooks.sh" ] && . "$DEPLOY/hooks.sh"
: "${NAME:?app.manifest must set NAME}" "${UNIXNAME:?app.manifest must set UNIXNAME}" "${BASE_PATH:?app.manifest must set BASE_PATH}" "${PORT:?app.manifest must set PORT}"
: "${TITLE:=$NAME}"
: "${PKGS:=py3-flask py3-waitress}"
: "${CODE_DIR:=/usr/local/$NAME}"
: "${SYNC:=app static deploy}"
: "${SRC_MARKER:=app/wsgi.py}"
: "${RSYNC_EXCLUDES:=__pycache__ .pytest_cache .venv tests docs archive}"
: "${CONF_FILE:=/etc/$UNIXNAME.conf}"
: "${CONF_LINES:=}"
: "${DIRS:=}"
: "${SVC_HOME:=/var/$NAME}"
: "${DAEMON:=/usr/local/bin/python3}"
: "${THREADS:=4}"
: "${RC_FLAGS:=-m waitress --listen=127.0.0.1:$PORT --threads=$THREADS wsgi:app}"
: "${RC_EXECDIR:=$CODE_DIR/app}"
: "${TABLE:=$UNIXNAME}"
: "${MARK:=app:$NAME}"
: "${ROUTES:=$BASE_PATH}"
: "${HEALTH_PATH:=$BASE_PATH/health}"
: "${REQUIRE_MOUNT:=}"
: "${SITE_AUTH:=0}"                         # 1 = this app uses the site's one login (kit/siteauth): register it and give it its own key
: "${AUTH_COOKIE_PATH:=$BASE_PATH}"
: "${AUTH_DIR:=/etc/site-auth}"
: "${SITE_AUTH_TOOL:=app/siteauth/keys.py}"
SVC_USER="_$UNIXNAME"

# validate every name before it is used in a command, a file name or a config line
case "$NAME" in ''|*[!a-z0-9-]*) die "NAME must be lowercase letters, digits and hyphens: '$NAME'" ;; esac
case "$UNIXNAME" in ''|*[!a-z0-9]*) die "UNIXNAME must be lowercase letters and digits only: '$UNIXNAME'" ;; esac
case "$PORT" in ''|*[!0-9]*) die "PORT must be a number: '$PORT'" ;; esac
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "PORT must be 1024-65535: $PORT"
for r in $ROUTES; do
  case "$r" in /*) ;; *) die "ROUTES entries must start with /: '$r'" ;; esac
  case "${r#/}" in ''|*[!a-z0-9-]*) die "ROUTES entries must be one lowercase path word, like /music: '$r'" ;; esac
done
case "$BASE_PATH" in /*) ;; *) die "BASE_PATH must start with /: '$BASE_PATH'" ;; esac

RELAYD_CONF="$ROOT/etc/relayd.conf"
CONF="$ROOT$CONF_FILE"
RCD="$ROOT/etc/rc.d/$UNIXNAME"

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
  if [ -n "$ROOT" ]; then [ "${APPKIT_TEST_ANSWER:-n}" = y ]; return; fi
  printf '   %s [y/N] ' "$1"; a=n; read -r a < /dev/tty || a=n
  [ "$a" = y ] || [ "$a" = Y ]
}
perm_of() { stat -f '%Su:%Sg %Lp' "$1"; }

TMP=$(mktemp); NEW=$(mktemp); CUR=$(mktemp); RULES=$(mktemp)
trap 'rm -f "$TMP" "$NEW" "$CUR" "$RULES"' EXIT
CHANGED=0

if [ -z "$ROOT" ]; then
  [ "$(id -u)" -eq 0 ] || die "run this with doas (it needs root)."
  [ "$(uname)" = OpenBSD ] || die "this installer is for OpenBSD."
  [ "$(uname -r)" = "7.9" ] || say "NOTE: tested on OpenBSD 7.9; this is $(uname -r). Read each step before agreeing."
fi
for m in $SRC_MARKER; do
  [ -e "$SRC/$m" ] || die "run this from the uploaded $NAME folder ($m not found next to deploy/)."
done
[ "$CHECK" = 1 ] && say "(--check: nothing will be changed)"
[ "$CODEONLY" = 1 ] && say "(--app-files-only: only the app code and a restart; no system file is touched)"

PY="${APPKIT_TEST_PYTHON:-$(command -v python3 2>/dev/null || echo /usr/local/bin/python3)}"
LOGIN_USER="${DOAS_USER:-${SUDO_USER:-}}"
case "$DIRS" in *@login*)
  if [ "$CODEONLY" = 0 ] && [ -z "$LOGIN_USER" ]; then printf 'Your login name on this server: '; read -r LOGIN_USER; fi ;;
esac

# ---- the optional separate volume: refuse to continue if it is not mounted ------------------------------
# Without this, files would land on the small boot disk under an empty mount point and look fine until the disk filled.
if [ -n "$REQUIRE_MOUNT" ] && [ "$CODEONLY" = 0 ]; then
  step "0. The storage volume $REQUIRE_MOUNT must be mounted"
  [ -d "$ROOT$REQUIRE_MOUNT" ] || die "$REQUIRE_MOUNT does not exist. Mount the volume first (see RESTORE.html, storage steps)."
  [ -f "$ROOT$REQUIRE_MOUNT/.volume-ok" ] || die "$REQUIRE_MOUNT has no .volume-ok file: the volume is probably not mounted. Mount it, then run: doas touch $REQUIRE_MOUNT/.volume-ok"
  if [ -z "$ROOT" ]; then
    a=$(df -P "$REQUIRE_MOUNT" | awk 'NR==2{print $1}'); b=$(df -P /var | awk 'NR==2{print $1}')
    [ "$a" != "$b" ] || die "$REQUIRE_MOUNT is on the same disk as /var: the volume is not mounted there."
  fi
  left "$REQUIRE_MOUNT is a mounted volume"
fi

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
step "1. Packages ($PKGS)"
missing=""
for p in $PKGS; do
  if [ -z "$ROOT" ] && ! pkg_info -q 2>/dev/null | grep -q "^$p-"; then missing="$missing $p"; fi
done
if [ -n "$missing" ]; then made "packages:$missing"; run pkg_add $missing; else left "all already installed (or test mode)"; fi

# ---- 2. service user, folders --------------------------------------------------------------------
step "2. Service user and folders"
if [ -n "$ROOT" ] || ! id "$SVC_USER" >/dev/null 2>&1; then
  made "user and group $SVC_USER"
  run groupadd "$SVC_USER"
  run useradd -g "$SVC_USER" -L daemon -s /sbin/nologin -d "$SVC_HOME" -c "$TITLE" "$SVC_USER"
else left "user $SVC_USER exists"; fi
ensure_dir "$CODE_DIR" root wheel 755
# DIRS entries are path,owner,group,mode ; owner/group may be @svc (the service user) or @login (you)
for spec in $DIRS; do
  p=${spec%%,*}; rest=${spec#*,}; o=${rest%%,*}; rest=${rest#*,}; g=${rest%%,*}; m=${rest#*,}
  case "$o" in @svc) o=$SVC_USER ;; @login) o=$LOGIN_USER ;; esac
  case "$g" in @svc) g=$SVC_USER ;; @login) g=$LOGIN_USER ;; esac
  ensure_dir "$p" "$o" "$g" "$m"
done
fi

# ---- 3. code -------------------------------------------------------------------------------------
step "3. $TITLE code to $CODE_DIR"
RS="-rlt --delete --itemize-changes --chmod=D755,F644 --chown=root:wheel"
for x in $RSYNC_EXCLUDES; do RS="$RS --exclude=$x"; done
SRCS=""; for s in $SYNC; do SRCS="$SRCS $SRC/$s"; done
if [ -z "$ROOT" ]; then
  # shellcheck disable=SC2086
  if [ "$CHECK" = 1 ]; then n=$(rsync $RS -n $SRCS "$CODE_DIR/" | wc -l)
  else n=$(rsync $RS $SRCS "$CODE_DIR/" | wc -l); fi
  if [ "$n" -eq 0 ]; then left "code is already up to date"; else chgd "$n file(s) in $CODE_DIR"; [ "$CHECK" = 1 ] || CHANGED=1; fi
else say "   [would run] rsync $RS$SRCS -> $CODE_DIR/"; fi

if [ "$CODEONLY" = 0 ]; then
# ---- 4. rc.d script ------------------------------------------------------------------------------
step "4. Service script /etc/rc.d/$UNIXNAME"
cat > "$TMP" <<RCEOF
#!/bin/ksh
# OpenBSD rc.d script for $TITLE (written by deploy/install.sh).

daemon="$DAEMON"
daemon_flags="$RC_FLAGS"
daemon_user="$SVC_USER"
daemon_execdir="$RC_EXECDIR"
daemon_logger="daemon.info"

. /etc/rc.d/rc.subr

rc_bg=YES
rc_reload=NO

rc_cmd \$1
RCEOF
# another app must not already listen on this port
# (this app's own script and the .pre-* backups this installer keeps are not "another app")
other=$(grep -l "listen=127.0.0.1:$PORT" "$ROOT"/etc/rc.d/* 2>/dev/null | grep -v "/$UNIXNAME\$" | grep -v '\.pre-' || true)
[ -z "$other" ] || die "port $PORT is already used by: $other (give this app another PORT in app.manifest)"
# "the same script" means the same settings: comments and blank lines (apart from the first line) are ignored
essence() { awk 'NR==1{print; next} /^[ \t]*#/{next} NF' "$1"; }
install_rcd() { mkdir -p "$(dirname "$RCD")"; cp "$TMP" "$RCD"; run chown root:bin "/etc/rc.d/$UNIXNAME"; chmod 555 "$RCD"; CHANGED=1; }
if [ ! -f "$RCD" ]; then
  made "$RCD"; [ "$CHECK" = 1 ] || install_rcd
else
  essence "$RCD" > "$CUR"; essence "$TMP" > "$NEW"
  if cmp -s "$CUR" "$NEW"; then left "$RCD has the same settings (comments may differ)"
  else
    say "   $RCD differs in its settings:"; diff -u "$RCD" "$TMP" | sed 's/^/   /' || true
    if [ "$REPAIR" = 1 ] && ask "Replace it with the version above? (a copy is kept as $RCD.pre-$UNIXNAME)"; then
      [ -f "$RCD.pre-$UNIXNAME" ] || cp -p "$RCD" "$RCD.pre-$UNIXNAME"; chgd "$RCD"; install_rcd
    else held "$RCD left as it is (use --repair to replace it)"; fi
  fi
fi

# ---- 5. the conf file (secrets; never overwritten) -----------------------------------------------
step "5. Settings and secrets $CONF_FILE"
if [ -f "$CONF" ]; then
  left "$CONF exists: never overwritten"
  # an app may offer repairs to its own conf (it must show each change and ask through "ask")
  if command -v app_repair_conf >/dev/null 2>&1; then app_repair_conf; fi
else
  made "$CONF (mode 640, root:$SVC_USER)"
  if [ "$CHECK" = 0 ]; then
    mkdir -p "$(dirname "$CONF")"
    if command -v app_create_conf >/dev/null 2>&1; then
      ( umask 077; app_create_conf > "$CONF" )
    else
      ( umask 077
        {
          printf '# %s (written by deploy/install.sh). Owner root, group %s, mode 640. Real environment variables win over this file.\n' "$CONF_FILE" "$SVC_USER"
          printf '%s\n' "$CONF_LINES" | while IFS= read -r l; do
            case "$l" in *@HEX32@*) l=$(printf '%s' "$l" | sed "s/@HEX32@/$(openssl rand -hex 32)/") ;; esac
            if [ -n "$l" ]; then printf '%s\n' "$l"; fi
          done
        } > "$CONF" )
    fi
    run chown "root:$SVC_USER" "$CONF_FILE"; chmod 640 "$CONF"; CHANGED=1
  fi
fi

# ---- 5b. the site's one login: register this app and write its own key -------------------------------------
if [ "$SITE_AUTH" = 1 ]; then
  step "5b. Site login: this app's own key in $AUTH_DIR/keys/$UNIXNAME.key"
  # an app may prepare the login's own files first (only the login service does)
  if command -v app_before_site_auth >/dev/null 2>&1; then app_before_site_auth; fi
  TOOL="$SRC/$SITE_AUTH_TOOL"
  if [ ! -f "$TOOL" ]; then held "$TOOL not found: this app was not given siteauth (run kit/sync-into.sh)"
  elif [ "$CHECK" = 1 ]; then
    if [ -f "$ROOT$AUTH_DIR/master" ]; then chgd "would register $UNIXNAME ($AUTH_COOKIE_PATH) and write its key if missing or stale"
    else held "the site login is not installed yet (no $AUTH_DIR/master): install the login app first"; fi
  else
    NOCHOWN=""; [ -n "$ROOT" ] && NOCHOWN="--no-chown"
    set +e
    # shellcheck disable=SC2086
    out=$("$PY" "$TOOL" ensure-app --dir "$ROOT$AUTH_DIR" --app "$UNIXNAME" --path "$AUTH_COOKIE_PATH" --user "$SVC_USER" $NOCHOWN 2>&1); rc=$?
    set -e
    if [ "$rc" = 3 ]; then held "the site login is not installed yet (no $AUTH_DIR/master): install the login app first, then re-run this installer"
    elif [ "$rc" != 0 ]; then die "could not set up the site login key: $out"
    elif [ "$out" = "already registered, key current" ]; then left "registered, key current"
    else chgd "site login: $out"; CHANGED=1; fi
  fi
fi

# ---- 6. relayd: send this app's paths to it ---------------------------------------------------------
step "6. relayd routes for $ROUTES"
# remove any block this app's installer wrote before; the app's own markers are "# BEGIN $MARK" / "# END $MARK"
# (the markers inside the protocol and relay blocks are indented, so compare with leading spaces removed)
awk -v b="# BEGIN $MARK" -v e="# END $MARK" '{l=$0; sub(/^[ \t]+/,"",l)} l==b{s=1;next} l==e{s=0;next} !s' "$RELAYD_CONF" > "$TMP"
for need in '^table <radicale>' '^  pass request quick header "Host"' 'forward to <radicale> port 5232'; do
  grep -q "$need" "$TMP" || die "relayd.conf has no line matching $need: it is not the Tech Independence layout, so nothing was changed."
done
if grep -q "<$TABLE>" "$TMP"; then
  left "relayd.conf already has rules for <$TABLE> that this installer did not write: untouched"
else
  # only a NEW app can clash: an app that already has its own rules is allowed to use its own port
  if grep -Eq "port $PORT([^0-9]|\$)" "$TMP"; then die "relayd.conf already forwards to port $PORT (another app?). Give this app another PORT in app.manifest."; fi
  : > "$RULES"
  for r in $ROUTES; do
    printf '  pass request quick path "%s" forward to <%s>\n' "$r" "$TABLE" >> "$RULES"
    printf '  pass request quick path "%s/*" forward to <%s>\n' "$r" "$TABLE" >> "$RULES"
  done
  # three insertions: the backend table, the path rules (before the first Host rule, because the first "quick" match wins),
  # and the relay's forward line
  awk -v mark="$MARK" -v table="$TABLE" -v port="$PORT" -v rf="$RULES" '
    /^  pass request quick header "Host"/ && !p {
      print "  # BEGIN " mark
      while ((getline line < rf) > 0) print line
      print "  # END " mark; p = 1 }
    { print }
    /^table <radicale>/ && !t { print "# BEGIN " mark; print "table <" table "> { 127.0.0.1 }"; print "# END " mark; t = 1 }
    /forward to <radicale> port 5232/ && !f { print "  # BEGIN " mark; print "  forward to <" table "> port " port; print "  # END " mark; f = 1 }
  ' "$TMP" > "$NEW"
  if cmp -s "$RELAYD_CONF" "$NEW"; then left "relayd.conf already has this app's block"
  else
    say "   relayd.conf would change:"; diff -u "$RELAYD_CONF" "$NEW" | sed 's/^/   /' || true
    if ask "Add these routes to relayd.conf? (a copy is kept as $RELAYD_CONF.pre-$UNIXNAME)"; then
      [ -f "$RELAYD_CONF.pre-$UNIXNAME" ] || { cp -p "$RELAYD_CONF" "$RELAYD_CONF.pre-$UNIXNAME"; say "   backup: $RELAYD_CONF.pre-$UNIXNAME"; }
      if [ -z "$ROOT" ]; then relayd -n -f "$NEW" || die "relayd rejected the new file: nothing was changed."; fi
      cp "$NEW" "$RELAYD_CONF"; chgd "relayd.conf (routes added)"; run rcctl reload relayd
    elif [ "$CHECK" = 1 ]; then chgd "relayd.conf (routes would be added)"
    else held "relayd.conf not changed: $TITLE will not be reachable until the routes are added"; fi
  fi
fi
fi   # end of "not --app-files-only"

# ---- start ---------------------------------------------------------------------------------------
step "Service"
if [ "$CODEONLY" = 0 ]; then
  if [ -z "$ROOT" ] && rcctl ls on 2>/dev/null | grep -qx "$UNIXNAME"; then left "$UNIXNAME is already enabled at boot"; else run rcctl enable "$UNIXNAME"; fi
fi
if [ "$CHANGED" = 1 ]; then
  # on a brand-new server the service is not running yet, and "restart" of a stopped service may report failure: then simply start it
  if ! run rcctl restart "$UNIXNAME"; then say "   restart reported a problem; trying a plain start"; run rcctl start "$UNIXNAME"; fi
elif [ -z "$ROOT" ] && [ "$CHECK" = 0 ]; then
  if rcctl check "$UNIXNAME" >/dev/null 2>&1; then say "   running; nothing needed restarting"; else run rcctl start "$UNIXNAME"; fi
else say "   (nothing changed, no restart needed)"; fi

step "Check"
if [ -z "$ROOT" ] && [ "$CHECK" = 0 ]; then
  i=0; ok=0
  while [ "$i" -lt 15 ]; do
    if curl -s "http://127.0.0.1:$PORT$HEALTH_PATH" | grep -q '"ok"'; then ok=1; break; fi
    i=$((i+1)); sleep 1
  done
  if [ "$ok" = 1 ]; then say "   PASS: $TITLE answers on 127.0.0.1:$PORT"; else say "   FAIL: no answer from $TITLE; see: tail /var/log/daemon"; fi
else say "   (skipped in --check / test mode)"; fi
say ""
say "Summary: $N_LEFT left alone, $N_NEW $( [ "$CHECK" = 1 ] && echo 'to create' || echo created ), $N_CHG $( [ "$CHECK" = 1 ] && echo 'to change' || echo changed ), $N_HELD held back."
[ "$N_HELD" -eq 0 ] || say "Held-back items were NOT changed. Re-run with --repair (or answer y) to apply them."
[ "$CHECK" = 1 ] && say "(--check: nothing was changed)"
exit 0
}

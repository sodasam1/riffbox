# Riffbox's own parts of the installer, sourced by appkit.sh: the first-time conf file (passphrase, phone token) and the two repairs
# offered on an existing one. Prompts go to the terminal (stderr) because the conf file is written from standard output.
app_create_conf() {
  PASS="${RIFFBOX_INSTALL_PASSPHRASE:-}"; TOK="${RIFFBOX_INSTALL_TOKEN:-}"
  if [ -z "$PASS" ]; then
    say "   Choose a long random passphrase (20+ characters) for the Riffbox login." >&2
    printf '   Passphrase: ' >&2; stty -echo 2>/dev/null || true; read -r PASS; stty echo 2>/dev/null || true; echo >&2
  fi
  if [ -z "$TOK" ]; then
    printf '   Paste your EXISTING phone upload token (so the iPhone Shortcut keeps working), or press Enter for a new one: ' >&2
    read -r TOK
    [ -n "$TOK" ] || { TOK=$(openssl rand -hex 32); say "   NEW token (put it in your Shortcut and password manager): $TOK" >&2; }
  fi
  HASH=$(printf '%s\n' "$PASS" | "$PY" "$SRC/deploy/hash_passphrase.py") || { say "   Could not hash the passphrase (it needs at least 15 characters)." >&2; exit 1; }
  say "   passphrase stored only as a salted hash ($("$PY" "$SRC/deploy/hash_passphrase.py" --method | cut -d: -f1))" >&2
  cat <<CONFEOF
# /etc/riffbox.conf (written by deploy/install.sh). Owner root, group _riffbox, mode 640. Real environment variables win over this file.
RIFFBOX_DATA_DIR=/var/riffbox
RIFFBOX_BASE_PATH=/ideas
RIFFBOX_STATIC_DIR=/usr/local/riffbox/static
RIFFBOX_BACKUP_DIR=/var/riffbox-backup
RIFFBOX_SECRET=$(openssl rand -hex 32)
RIFFBOX_UPLOAD_TOKEN=$TOK
RIFFBOX_PASSPHRASE_HASH=$HASH
CONFEOF
}

app_repair_conf() {
  if grep -q '^RIFFBOX_PASSPHRASE=' "$CONF"; then
    say "   $CONF stores the passphrase as plain text. It can be replaced by a salted hash (your login stays the same; every other line is kept)."
    if [ "$REPAIR" = 1 ] && ask "Replace the plain-text passphrase with a hash?"; then
      "$PY" "$SRC/deploy/hash_passphrase.py" --upgrade-conf "$CONF"; chgd "$CONF (passphrase is now a hash)"; CHANGED=1
    else held "plain-text passphrase left as it is (use --repair to convert it; the app still accepts it for now)"; fi
  fi
  if ! grep -q '^RIFFBOX_BACKUP_DIR=' "$CONF"; then
    say "   $CONF has no RIFFBOX_BACKUP_DIR line, so the Back up now button on the Backup and export page is switched off."
    if [ "$REPAIR" = 1 ] && ask "Add the line RIFFBOX_BACKUP_DIR=/var/riffbox-backup to it?"; then
      printf 'RIFFBOX_BACKUP_DIR=/var/riffbox-backup\n' >> "$CONF"; chgd "$CONF (backup folder setting added)"; CHANGED=1
    else held "no backup folder is set (use --repair to add the line); the Back up now button stays off"; fi
  fi
}

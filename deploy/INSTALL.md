# Installing (and re-installing) Riffbox: one file

Riffbox is an app with its own installer, separate from the site kit. After Tech Independence is done (and the kit's
`install.sh`, if you use `/private/` pages), this is the whole procedure. It is the same for a first install, a routine
update, and a rebuild after the server was wiped.

1. **Upload** the whole `riffbox` folder (it must contain `app/`, `static/` and `deploy/`) to your home folder on the server,
   so it ends up as `~/riffbox`. Use the ZIP from GitHub, not `git clone`, so Windows keeps Unix line endings.
2. **Look first** (changes nothing):
   ```sh
   doas sh ~/riffbox/deploy/install.sh --check
   ```
3. **Do it:**
   ```sh
   doas sh ~/riffbox/deploy/install.sh
   ```
   It only applies differences, so running it again after an update just copies the new files and restarts the service.
   On a brand-new install it asks for a login passphrase and for your phone upload token: paste your existing token so the
   iPhone Shortcut keeps working, or press Enter for a new one (then update the Shortcut once, `SHORTCUT.md` section 0).
4. **Riffbox data restore** (only after a wipe): upload your backup folder to `/var/riffbox-restore` and use the Restore section
   of the app's Backup and export page (branch `in-app-restore`). The installer itself never touches your recordings.

## What the installer does, and the same steps by hand
If the script ever stops working on a future OpenBSD, these are the same steps. `doas` runs a command as root.

| # | By hand | Why |
|---|---|---|
| 1 | `doas pkg_add py3-flask py3-waitress ffmpeg` | Riffbox's three packages (Python itself is already there because Radicale needs it). |
| 2 | `doas groupadd _riffbox` then `doas useradd -g _riffbox -L daemon -s /sbin/nologin -d /var/riffbox -c "Riffbox" _riffbox` | An account that cannot log in and owns only Riffbox's files, so an app bug cannot touch the rest of the server. |
| 3 | `doas install -d -o root -g wheel -m 755 /usr/local/riffbox`; `doas install -d -o _riffbox -g _riffbox -m 750 /var/riffbox`; `doas install -d -o _riffbox -g _riffbox -m 755 /var/riffbox-backup`; `doas install -d -o YOURUSER -g YOURUSER -m 755 /var/riffbox-restore` | Code folder (root-owned), data (private to the app), backups (readable so your sync can pull them), restore drop folder (you can upload into it). |
| 4 | `doas rsync -rlt --delete --chmod=D755,F644 --chown=root:wheel ~/riffbox/app ~/riffbox/static ~/riffbox/deploy /usr/local/riffbox/` | Copies the code into place; `--delete` removes files you removed. Never touches data or secrets. |
| 5 | Create `/etc/riffbox.conf` (see `riffbox.conf.example`), then `doas chown root:_riffbox /etc/riffbox.conf; doas chmod 640 /etc/riffbox.conf` | Settings and secrets; only root and the app can read it. Get random secrets with `openssl rand -hex 32`. |
| 6 | Write the rc script (copy the `RCEOF` block in `install.sh`) to `/etc/rc.d/riffbox`, `doas chmod 555` it | How OpenBSD starts the service. |
| 7 | `doas cp -p /etc/relayd.conf /etc/relayd.conf.pre-riffbox`, then `doas vi /etc/relayd.conf` and add three things: `table <riffbox> { 127.0.0.1 }` after the `table <radicale>` line; two lines `pass request quick path "/ideas" forward to <riffbox>` and `... path "/ideas/*" ...` **before** the first `pass request quick header "Host"` line; `forward to <riffbox> port 8100` inside the `relay` block. Then `doas relayd -n` and `doas rcctl reload relayd`. | relayd is the front door; the first "quick" rule that matches wins, so the Riffbox paths must come first. `-n` checks syntax without applying. |
| 8 | `doas crontab -e` and add `30 3 * * * /usr/local/bin/python3 /usr/local/riffbox/deploy/backup.py /var/riffbox /var/riffbox-backup > /dev/null; chown -R _riffbox:_riffbox /var/riffbox-backup` | Every night at 03:30 (minute hour day month weekday command) back up the database and audio. |
| 9 | `doas rcctl enable riffbox; doas rcctl restart riffbox` | Start at boot, and now. |
| 10 | `curl -s http://127.0.0.1:8100/ideas/health` | Should print `{"status":"ok"}`. |

## Not verified
The installer's file edits are tested against your real `relayd.conf` (and the original from Tech Independence), but
`pkg_add`, `useradd`, `rcctl`, `relayd -n` and `crontab` can only be run on OpenBSD: the first run on your server is the test,
which is why `--check` exists and why it keeps `/etc/relayd.conf.pre-riffbox`. On your current server the hand-written
relayd rules are detected and left alone, and `/etc/riffbox.conf` is never overwritten.

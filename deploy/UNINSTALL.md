# Removing Riffbox completely

Riffbox is built so that everything it adds to your server is on this one list. Remove the items and
the server is back to how it was before Riffbox. Nothing here touches your website, email, Radicale,
certificates, DNS or firewall, because Riffbox never changes them.

## Everything Riffbox adds

| # | What | Where | Added in | Shared with other things? |
|---|---|---|---|---|
| 1 | Three lines in the relay config | `/etc/relayd.conf` | step 7 | **Yes** (your main site and `dav.` use this file) |
| 2 | Service script | `/etc/rc.d/riffbox` | step 6 | No |
| 3 | "Start at boot" entry | `/etc/rc.conf.local` | step 6 (`rcctl enable`) | **Yes** (file also holds other settings) |
| 4 | Secrets file | `/etc/riffbox.conf` | step 4 | No |
| 5 | Service user and group | `_riffbox` in `/etc/passwd` and `/etc/group` | step 3 | **Yes** (system files) |
| 6 | The code | `/usr/local/riffbox` | step 3 / deploys | No |
| 7 | **Your recordings and database** | `/var/riffbox` | step 3 / use | No. **This is your data** |
| 8 | Python packages (Flask, waitress and their helpers) | `/usr/local` via `pkg_add` | step 2 | Possibly some helpers (see below) |
| 8b | `ffmpeg` and its libraries (only if you did `deploy/PHASE3_5.md`) | `/usr/local` via `pkg_add` | phase 3.5 | Possibly some libraries (see below) |
| 9 | Upload leftovers in your home directory | `~/riffbox-incoming`, `~/install-riffbox.sh`, `~/riffbox.tgz` | step 5 | No |

Later phases may add more (a nightly backup job in Phase 8, a digest e-mail if built). This file is
updated whenever that happens.

## Optional: record a baseline before step 7

Step 7 is the first time a file other than Riffbox's own gets edited. Run this on the server just
before it, to keep copies of the shared files as they are right now:
```sh
mkdir -p ~/riffbox-baseline
for f in relayd.conf httpd.conf acme-client.conf pf.conf doas.conf rc.conf.local passwd group; do cp -p /etc/$f ~/riffbox-baseline/ 2>/dev/null; done
doas crontab -l > ~/riffbox-baseline/root-crontab.txt
pkg_info > ~/riffbox-baseline/pkg_info.txt
```
CHECK: `ls ~/riffbox-baseline` lists those files. They contain no secrets (your Riffbox secrets file is
deliberately not copied). Note this baseline is taken after steps 1 to 4, so it already includes
the Riffbox user, the packages and the service files; what it protects is everything else, above
all `relayd.conf`.

## The only copy of your data

Before removing anything, if you've uploaded recordings you want to keep, copy `/var/riffbox/audio`
off the server first (FreeFileSync, server to computer, folder `/var/riffbox/audio`; your login user
can't read it directly, so first run `doas cp -r /var/riffbox/audio ~/riffbox-audio-copy` and
`doas chown -R YOURUSER ~/riffbox-audio-copy`). Deleting `/var/riffbox` is permanent.

## Removal, in this order

Order matters: first stop sending traffic to the app, then stop the app, then delete it.

### 1. Take the route out of relayd
If you made the backup in step 7 and haven't edited relayd since:
```sh
doas cp -p /etc/relayd.conf.bak /etc/relayd.conf
```
Otherwise open `doas vi /etc/relayd.conf` and delete the three Riffbox additions (the
`table <riffbox>` line, the two `path "/ideas..."` lines, and `forward to <riffbox> port 8100`).
Then:
```sh
doas relayd -n
doas rcctl reload relayd
```
CHECK: `configuration OK`, and `https://sanjaysubramanian.com/` and `https://dav.sanjaysubramanian.com`
still load. `https://sanjaysubramanian.com/ideas/` now shows your normal site's "not found" page.

### 2. Stop and remove the service
```sh
doas rcctl stop riffbox
doas rcctl disable riffbox
doas rm /etc/rc.d/riffbox
```
CHECK: `grep riffbox /etc/rc.conf.local` prints nothing. If it prints a line, remove that line with
`doas vi /etc/rc.conf.local`. (`rcctl disable` normally cleans it, but check, since I can't
test OpenBSD's exact behaviour here.)

### 3. Delete the files
```sh
doas rm /etc/riffbox.conf
doas rm -r /usr/local/riffbox
doas rm -r /var/riffbox
rm -r ~/riffbox-incoming
rm -f ~/install-riffbox.sh ~/riffbox.tgz
```
(`/var/riffbox` is your recordings: only run that line once you have a copy, or no longer care.)

### 4. Remove the service user
```sh
doas userdel _riffbox
doas groupdel _riffbox
```
`groupdel` may report that the group doesn't exist (if `userdel` already removed it). That's fine.
CHECK: `grep riffbox /etc/passwd /etc/group` prints nothing.

### 5. Remove the Python packages
First remove the two you installed:
```sh
doas pkg_delete py3-flask py3-waitress
```
If you installed ffmpeg for the FLAC play copies, remove it too:
```sh
doas pkg_delete ffmpeg
```
Then see which leftover helper packages nothing needs any more. **Dry run first (`-n` changes nothing):**
```sh
doas pkg_delete -a -n
```
It should list only Flask's helpers (names such as Werkzeug, Jinja2, MarkupSafe, itsdangerous, click,
blinker) and, if you removed ffmpeg, its libraries. **If it lists anything that isn't one of those, stop and
don't continue.** If it only lists those:
```sh
doas pkg_delete -a
```
Never use `pkg_delete -aa`: that deletes far more. Helpers that Radicale also needs are kept
automatically, because something still depends on them.
CHECK: `pkg_info | grep -iE 'flask|waitress|ffmpeg'` prints nothing, and `rcctl check radicale` still says ok.

## Check that nothing is left
```sh
grep -ri riffbox /etc/relayd.conf /etc/rc.conf.local /etc/passwd /etc/group
ls -d /usr/local/riffbox /var/riffbox /etc/riffbox.conf /etc/rc.d/riffbox ~/riffbox-incoming 2>&1
rcctl ls all | grep riffbox
```
CHECK: the `grep` and `rcctl` print nothing, and every `ls` line says "No such file or directory".
If you took the baseline, compare the shared files:
```sh
diff ~/riffbox-baseline/relayd.conf /etc/relayd.conf && echo "relayd.conf identical"
diff ~/riffbox-baseline/rc.conf.local /etc/rc.conf.local
```
(`rc.conf.local` will differ only by the removal of the `riffbox` lines, because the baseline was
taken after `rcctl enable`.)

## Emergency lever: a Vultr snapshot
A Vultr snapshot of the whole server, taken before step 7, is a full undo for anything. I haven't
verified Vultr's current snapshot pricing or restore behaviour, so check the Vultr console. The
trade-off: restoring a snapshot reverts the **entire** server to that moment, including any mail
received since. So use the steps above for normal removal and keep a snapshot only as a last resort.

## About "undo anything I changed before Riffbox"
This only reverses what Riffbox added. If you made other changes to the server before starting, I
can't know what they were, and this list can't undo them. The baseline above and a Vultr snapshot
are the only ways to capture the state of those.

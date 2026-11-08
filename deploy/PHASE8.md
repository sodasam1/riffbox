# Phase 8 runbook: Trash, backup, restore drill and export

**What is new in the app:** *Delete* (in the edit form, pressed twice) moves a recording to a **Trash** tab; *Restore*
brings it back with all its tags and notes. Nothing is removed from disk. **Deploy:** the routine two moves
(FreeFileSync, then `sh ~/install-riffbox.sh`). No new package, no config change, no database step (the Trash uses the
`deleted_at` column that has always been there).

**What is new on the server's disk:** the app now keeps big uploads' temporary files in `/var/riffbox/tmp` instead of
the system `/tmp`. It creates the folder itself and empties it at every start.

The two scripts below need only Python (already installed) and live in `/usr/local/riffbox/deploy/` after a deploy.
They never import the app, so they keep working even if Flask is gone.

## 1. Try a backup by hand
```sh
df -h /var
```
CHECK: the free space is more than the size of `/var/riffbox/audio` (a backup holds a second copy of your originals).
```sh
doas mkdir -p /var/riffbox-backup
doas /usr/local/bin/python3 /usr/local/riffbox/deploy/backup.py /var/riffbox /var/riffbox-backup
```
CHECK: it prints `database -> riffbox-<date>.db; N new audio file(s) copied` and no WARNING lines. Run it a second
time: `0 new audio file(s) copied`.

## 2. Make it nightly
```sh
doas crontab -e
```
Add one line (the output is thrown away on purpose, so the only mail you get from cron is a WARNING or an error):
```
30 3 * * * /usr/local/bin/python3 /usr/local/riffbox/deploy/backup.py /var/riffbox /var/riffbox-backup > /dev/null
```
It keeps the newest 14 database copies (`--keep N` changes that). Audio is only ever added to the backup.

## 3. A backup on the same server is not enough
If the VPS is lost, so is the backup. Add `/var/riffbox-backup` (read it with `doas`, or copy it to your home folder
first, as you do for Radicale's `radbak`) as a folder in your FreeFileSync job and pull it to your own computer. Then
the data exists in two places you control.

## 4. The restore drill (do this once now, then about once a year)
This proves a backup can bring the app back using nothing from the server. On **your computer**, with Python 3:
1. Make a folder, e.g. `drill`, with an `audio` folder inside. Copy the newest `riffbox-....db` from the backup's `db`
   folder to `drill/riffbox.db`, and the backup's `audio` files into `drill/audio/`.
2. From the repository's `app` folder (see the README's "Run locally" for the first line):
```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
RIFFBOX_DATA_DIR=/path/to/drill RIFFBOX_SECRET=dev RIFFBOX_PASSPHRASE=pw RIFFBOX_INSECURE_COOKIES=1 \
  .venv/bin/waitress-serve --listen=127.0.0.1:8100 wsgi:app
```
3. Open `http://127.0.0.1:8100/`, log in with `pw`. CHECK: your recordings, tags and notes are there and play.
The automated tests do the same thing with a scratch folder (`test_backup_export.py`), but only you can prove it
with your real data.

## 5. Export everything to plain files
```sh
doas -u _riffbox /usr/local/bin/python3 /usr/local/riffbox/deploy/export.py /var/riffbox /tmp/riffbox-export
```
Then fetch `/tmp/riffbox-export` with your SFTP tool and delete it on the server. Open `index.html` in the folder to
look around. Details of what it contains are on the app's *How this works* page, "Keeping your data portable".
Add `--include-trash` to include deleted recordings. It refuses to write into a folder that already has files in it.

## What did not change
Soft delete is the only deletion: there is deliberately no "empty the Trash" button yet, because originals are never
removed by the app. If you ever need the space back, that is a separate, explicit step.

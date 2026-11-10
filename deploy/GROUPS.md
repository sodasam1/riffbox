# Deploying groups (ideas made of several recordings)

Groups change the database (additively) the first time the new version starts. Nothing is dropped or rewritten, and the
routine deploy in `PHASE2.md` is unchanged, but the first deploy deserves a rehearsal on a copy of your real data. Nothing
below touches the live server until step 5.

## 1. Take a fresh export and a backup (live site)
- **Backup and export** page: *Download the export (.zip)* (tick *Include recordings in the Trash* if you want the Trash
  restorable too), and press *Back up now*. Copy the zip to your computer: it is your restore point.

## 2. Rehearse on your computer (about 10 minutes)
With Python 3 and the repository's `app/requirements.txt` installed (see the README's "Run locally"):
```sh
python3 deploy/restore.py ~/Downloads/riffbox-export.zip /tmp/rb-rehearsal
```
`restore.py` rebuilds a data folder from the export, checks every checksum and lists anything missing (Trash entries have no
audio unless you ticked the Trash box; add `--drop-missing-trash` to remove those rows from the copy). Then start the new code
on the copy:
```sh
cd app
RIFFBOX_DATA_DIR=/tmp/rb-rehearsal RIFFBOX_SECRET=dev RIFFBOX_PASSPHRASE=pw RIFFBOX_UPLOAD_TOKEN=tok RIFFBOX_INSECURE_COOKIES=1 \
  .venv/bin/waitress-serve --listen=127.0.0.1:8100 wsgi:app
```
Open http://127.0.0.1:8100/ and check, against the live site:
- Inbox, Library, Trash and Resurface counts are the same; five ideas you know show the same title, tags, mark, BPM, key, notes
  and both dates.
- Edit something, mark a ♥, trash and restore one, upload one file: all work.
- Make a group of two Inbox recordings (Select, tick, **Group…**), open it with the caret, play both parts, **Break up this idea**.
- **Backup and export** builds a zip, and the new export restores (`restore.py` again) to an identical library.
Restart the rehearsal server twice: the numbers do not change (the migration is repeatable).

## 3. Rollback drill (optional, 5 minutes)
Start the **old** version (a ZIP of an earlier release, or `git checkout` of the commit before groups) on the same rehearsal folder:
it opens, and shows every edit you made in step 2 *as long as no multi-recording group exists* (an idea of several recordings is
only understood by the new version; break it up first). Rehearsed by the project's own tests on a synthetic library; this
step is for your real data.

## 4. Deploy
The routine deploy in `PHASE2.md` (download the ZIP, replace the local folder, FreeFileSync, `sh ~/install-riffbox.sh`). No new
package, no change to `/etc/riffbox.conf`, relayd or the rc.d script. The migration runs when the service starts (a second or
two for a few thousand recordings).

## 5. After deploying (live site)
Repeat the short checks from step 2 on the live site (counts, an edit, a ♥, one upload, the iPhone Shortcut: send one memo and
see it in the Inbox), and open **Backup and export** to confirm the status line is healthy.

## Going back
Deploy the previous ZIP the same way. The database keeps the extra tables and columns; the older version ignores them. Ideas made
of several recordings appear as separate recordings again, each with the details it had when it was grouped; changes made to
the group's own tags, notes and marks since then stay in the database but are not shown by the older version.

## Things to know
- The export carries a group as one note (`[idea N]`) plus one audio file per part (`part 2 Kit [13].m4a`); a single idea
  exports exactly as before. `restore.py` maps audio back by the `[number]` at the end of each file name.

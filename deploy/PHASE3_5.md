# Phase 3.5 runbook: FLAC play copies (so Chrome can play Apple Lossless memos)

**The problem:** iPhone Voice Memos set to *Lossless* records Apple Lossless (ALAC). Safari plays
it; Chrome, Edge and Firefox on a computer do not.

**The fix:** when an ALAC memo is uploaded, the server keeps your original untouched and, in the
background, makes a **FLAC copy** for the player. ALAC to FLAC loses nothing (both are lossless, and
the tests compare the decoded audio sample for sample). *Download* always gives you the original.
Memos that already play everywhere (normal AAC) get no copy and use no extra space.

**What it costs:** one extra package on the server (`ffmpeg`, plus whatever it depends on), and
disk space: an ALAC memo ends up stored twice, at roughly the same size each time. The app works
without ffmpeg; ALAC memos then simply have no browser-friendly copy.

Everything below runs on the server unless it says otherwise. Do the steps in order and stop at any
CHECK that doesn't match.

## 1. See what installing ffmpeg would add (changes nothing)
```sh
pkg_info -Q ffmpeg
```
CHECK: lists one or more `ffmpeg-...` packages. If it prints nothing, stop and tell me.
```sh
doas pkg_add -n ffmpeg
```
`-n` means "pretend": it prints every package it would install and installs nothing. Read the list.
It will be longer than Flask's was (ffmpeg needs several libraries). If the list or size looks like
more than you want on this server, stop here; the app still works, and the alternative is setting
Voice Memos to *Compressed* on the iPhone. If it looks fine, continue.

## 2. Install it
```sh
doas pkg_add ffmpeg
```
If it asks you to choose between versions or flavors, pick the plain `ffmpeg` (no suffix) and send me
the choices if unsure.
```sh
which ffmpeg
```
CHECK: prints a path, expected `/usr/local/bin/ffmpeg`.
Check the service's account can run it (this is the account that will call it):
```sh
doas -u _riffbox /usr/local/bin/ffmpeg -version | head -1
```
CHECK: prints a line starting `ffmpeg version`. (Use the path from `which` above if it differed.)

## 3. Tell Riffbox where it is
Open the config file:
```sh
doas vi /etc/riffbox.conf
```
Add one line (use your real path from step 2) and save:
```
RIFFBOX_FFMPEG=/usr/local/bin/ffmpeg
```
CHECK: `doas grep FFMPEG /etc/riffbox.conf` prints that line. (The app would likely find ffmpeg
on its own; this line removes the guesswork.)

## 4. Deploy the new code (your usual routine)
On your computer: download the new ZIP, replace your local `riffbox` folder, FreeFileSync
(**COMPARE**, then **SYNCHRONIZE**), then on the server:
```sh
sh ~/install-riffbox.sh
```
CHECK: ends with `deployed`. The restart is what makes the server look through your existing
recordings: it finds the ALAC ones and queues FLAC copies for them. Your existing memo is converted
automatically, with nothing to re-upload.

## 5. Check it worked
After 10 to 30 seconds (a short memo takes about a second; the server converts one at a time):
```sh
doas ls -l /var/riffbox/audio
```
CHECK: next to each `.m4a` you uploaded in ALAC there is now a `.flac` file of similar size, and
no `.incoming-...` leftovers. If there is no `.flac`, look at the log:
```sh
doas tail -30 /var/log/daemon
```
and send me what it says (look for lines containing `riffbox`).

Then, in Chrome on your computer: open https://sanjaysubramanian.com/ideas/, reload, and press play
on the ALAC memo. For a few seconds after the restart you may see a "preparing playback…" label next
to it; the page refreshes itself and the label goes away.

**Gate: the ALAC memo plays in Chrome, and Download still gives you the original `.m4a`.**

## If something goes wrong
- *Conversion failed:* the row shows "no play copy" and plays the original where the browser
  supports it. Nothing is lost. Send me the `/var/log/daemon` lines.
- *Back out the feature:* remove the `RIFFBOX_FFMPEG` line from `/etc/riffbox.conf`, run
  `doas rcctl restart riffbox`, and uninstall with `doas pkg_delete ffmpeg`, then the dry run
  `doas pkg_delete -a -n` to see which helper libraries nothing else needs (read the list before
  running `doas pkg_delete -a`; never `-aa`). Existing `.flac` copies can stay or be deleted from
  `/var/riffbox/audio`; the originals are separate files.
- Full removal of Riffbox: `deploy/UNINSTALL.md` (updated to include ffmpeg).

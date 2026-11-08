# Phase 2 runbook: first deploy to your OpenBSD server

Target URL: **https://sanjaysubramanian.com/ideas/**. No DNS or certificate changes are needed:
the existing certificate already covers the main domain, and only relayd's routing changes.

Do the steps in order. After each **CHECK**, stop and compare. If it doesn't match,
don't continue; send me the output. Steps 1 to 6 do not touch relayd,
so your existing site and email cannot be affected by them.

`HOST` below means your own login, e.g. `you@sanjaysubramanian.com`.

## One-time server setup (run on the server, after `ssh HOST`)

### 1. Prerequisites
```sh
which python3; grep -c daemon_execdir /etc/rc.d/rc.subr; grep -c daemon_logger /etc/rc.d/rc.subr
```
CHECK: a path (expected `/usr/local/bin/python3`), then two numbers that are both 1 or more.
If `which` prints a different path, edit `daemon=` in `deploy/rc.d/riffbox` to match.
If a number is 0, tell me; I'll adjust the rc.d script.

### 2. Install packages
```sh
doas pkg_add py3-flask py3-waitress
```
CHECK: ends without errors.
```sh
python3 -c 'import flask, waitress; print("ok")'
```
CHECK: prints `ok`.

### 3. Service user and data directory
```sh
doas groupadd _riffbox
doas useradd -g _riffbox -L daemon -s /sbin/nologin -d /var/riffbox -c "Riffbox" _riffbox
doas install -d -o _riffbox -g _riffbox -m 750 /var/riffbox
doas install -d -o root -g wheel -m 755 /usr/local/riffbox
```
CHECK: `id _riffbox` shows a uid and group `_riffbox`; `ls -ld /var/riffbox` shows `drwxr-x--- ... _riffbox _riffbox`.

### 4. Config with secrets
```sh
echo "secret: $(openssl rand -hex 32)"; echo "token: $(openssl rand -hex 32)"
```
Copy these two values somewhere safe (the token is what a future Shortcut will use).
Now create the file and edit it (replace each CHANGE-ME; pick your own login passphrase):
```sh
doas vi /etc/riffbox.conf
```
Contents to type (see `deploy/riffbox.conf.example`):
```
RIFFBOX_DATA_DIR=/var/riffbox
RIFFBOX_BASE_PATH=/ideas
RIFFBOX_STATIC_DIR=/usr/local/riffbox/static
RIFFBOX_SECRET=<first value>
RIFFBOX_UPLOAD_TOKEN=<second value>
RIFFBOX_PASSPHRASE=<your passphrase>
```
Then lock it down:
```sh
doas chown root:_riffbox /etc/riffbox.conf; doas chmod 640 /etc/riffbox.conf
```
CHECK: `ls -l /etc/riffbox.conf` shows `-rw-r----- ... root _riffbox`.

## First code upload (FreeFileSync, the same way you upload your website)

How this works, in one paragraph: FreeFileSync copies the Riffbox folder from your computer to a
**staging folder in your home directory** on the server (`~/riffbox-incoming`). It can't write
straight to `/usr/local/riffbox` because that folder is owned by root, and FreeFileSync logs in as
you. So a tiny script on the server then copies staging to `/usr/local/riffbox` and restarts the app.
Every deployment, now and later, is the same two moves: **FreeFileSync, then one command.**
Deployments never touch your secrets (`/etc/riffbox.conf`) or your recordings (`/var/riffbox`).

### 5a. Get the code onto your computer (Windows)
1. Open the repository page on GitHub and click the green **Code** button, then **Download ZIP**.
2. Extract the ZIP. You get a folder named `riffbox-main`. **Rename it to `riffbox`** and put it
   somewhere permanent, e.g. `C:\Users\YOURNAME\riffbox`. Inside it you should see the folders
   `app`, `static`, `deploy` and `tests`. Remember this location; FreeFileSync will point at it.

Use the ZIP rather than `git clone`. On Windows, git can silently convert line endings in the
server script `deploy\rc.d\riffbox`, which then fails on OpenBSD. The ZIP keeps them correct.

### 5b. One-time: create the staging folder (on the server)
```sh
ssh YOURUSER@sanjaysubramanian.com
```
```sh
mkdir -p ~/riffbox-incoming
```
CHECK: `ls -d ~/riffbox-incoming` prints `/home/YOURUSER/riffbox-incoming`. Leave this terminal open.

### 5c. One-time: create the install script (on the server, same terminal)
This is the "one command" you will run after every FreeFileSync upload. Copy and paste all of it:
```sh
cat > ~/install-riffbox.sh <<'EOF'
#!/bin/sh
set -e
doas rsync -rlt --delete --chmod=D755,F644 --chown=root:wheel "$HOME/riffbox-incoming/" /usr/local/riffbox/
doas rcctl restart riffbox || echo "(riffbox service not installed yet: normal on the very first deploy)"
echo "deployed"
EOF
```
CHECK: `cat ~/install-riffbox.sh` shows those 5 lines.
What it does: copies the staging folder over `/usr/local/riffbox` (and removes anything there that
you've since removed from the code), then restarts the app. It only ever touches `/usr/local/riffbox`.

### 5d. Set up FreeFileSync (on your computer)
Same settings you used for your website, with a different destination folder.
1. Open FreeFileSync.
2. Top-left folder box: click **[Browse]** and choose your `riffbox` folder from step 5a (the one
   that contains `app`, `static` and `deploy`).
3. Top-right folder box: click the white **cloud icon**, then **SFTP**, and fill in:
   - Server name or IP address: `sanjaysubramanian.com`
   - Select **(*) Key File**
   - Username: your **server** username (the one you log in with)
   - Key file: type `C:\Users\YOURNAME\.ssh\id_ed25519` (your Windows username here; the file
     **without** `.pub`)
   - Directory on server: `/home/YOURUSER/riffbox-incoming`
   - Click **OK**.
4. Top-right: click the **green gear wheel**, choose **MIRROR →**, click **OK**.
   (Mirror makes the staging folder an exact copy of your local folder. That is safe here because it
   only affects `riffbox-incoming`. **Never use Mirror pointed at your home directory, `/var/www`
   or `/usr/local`.**)
5. Click **COMPARE**. The first time, the left side should show everything as "create" and the right
   side empty. If the right side lists lots of unrelated files, **stop**: the destination folder is wrong.
6. Click **SYNCHRONIZE**, then **[Start]**.
7. **Save this setup:** menu **File → Save as...**, name it `riffbox.ffs_gui`, and keep it in
   Documents. Next time you just double-click that file.

CHECK (on the server): `ls ~/riffbox-incoming` lists `app`, `deploy`, `static` and `tests`.

### 5e. Install it (on the server)
```sh
sh ~/install-riffbox.sh
```
CHECK: it prints the "service not installed yet" note (normal this one time) and then `deployed`.
```sh
ls /usr/local/riffbox/app/riffbox
```
CHECK: lists `__init__.py`, `config.py` and `schema.sql`.

## Start the service (server)

### 6. Install the rc.d script and start it
The script came along with your upload, so there's nothing more to copy:
```sh
doas install -m 555 -o root -g bin /usr/local/riffbox/deploy/rc.d/riffbox /etc/rc.d/riffbox
```
Check it wasn't given Windows line endings (this should print `0`):
```sh
grep -c "$(printf '\r')" /etc/rc.d/riffbox
```
```sh
doas rcctl enable riffbox
doas rcctl start riffbox
```
CHECK: `rcctl check riffbox` prints `riffbox(ok)`.
```sh
curl -s http://127.0.0.1:8100/ideas/health
```
CHECK: `{"status":"ok"}`. If not: `doas tail -20 /var/log/daemon` shows the Python error.

**Gate A: the app runs on the server, on loopback only.**

## Public access: relayd only

Only start this after Gate A. This is the first step that edits a file shared with your main site,
so first record a baseline of the shared files (commands in `deploy/UNINSTALL.md`, section
"Optional: record a baseline before step 7"). `deploy/UNINSTALL.md` is also the complete,
step-by-step way to remove Riffbox and return the server to how it was.

Then back up relayd:
```sh
doas cp -p /etc/relayd.conf /etc/relayd.conf.bak
```

### 7. Edit `/etc/relayd.conf` (`doas vi /etc/relayd.conf`), three additions
a. Under `table <radicale> { 127.0.0.1 }` add:
```
table <riffbox> { 127.0.0.1 }
```
b. In the `http protocol "https"` block, **above** the line `pass request quick header "Host" value "sanjaysubramanian.com" forward to <httpd>`, add:
```
  pass request quick path "/ideas" forward to <riffbox>
  pass request quick path "/ideas/*" forward to <riffbox>
```
Order matters: relayd stops at the first `quick` match, so these must come before the Host rules.
Two rules are used on purpose so that a future page like `/ideas-notes.html` on your main site is not captured.
c. Inside `relay "https" { ... }`, under `forward to <radicale> port 5232` add:
```
  forward to <riffbox> port 8100
```
CHECK: `doas relayd -n` prints `configuration OK`.
If it rejects the `path` lines, show me the exact error; I have not been able to test relayd's
syntax here and will adjust.

### 8. Apply
```sh
doas rcctl reload relayd
```
CHECK from your computer (PowerShell; `curl.exe`, not `curl`):
```powershell
curl.exe -s https://sanjaysubramanian.com/ideas/health
curl.exe -s -o NUL -w "%{http_code}`n" https://sanjaysubramanian.com/ideas
curl.exe -s -o NUL -w "%{http_code}`n" https://sanjaysubramanian.com/
```
Expect `{"status":"ok"}`, then `302` (redirect to `/ideas/`), then `200` (your normal home page).
Also open https://sanjaysubramanian.com/ideas/ in a browser: a plain "Riffbox is running" page.
Confirm `https://dav.sanjaysubramanian.com` and your main site still load.

**Gate B: public HTTPS works at /ideas; existing site and services unaffected.**

## Upload tests (from your computer)

### 10. Auth and a large upload
Create a 50 MB test file, then upload it with your token (replace TOKEN):
```powershell
$b = New-Object byte[] 52428800; (New-Object Random).NextBytes($b); [IO.File]::WriteAllBytes("$PWD\big.wav", $b)
curl.exe -s -o NUL -w "%{http_code}`n" -F file=@big.wav https://sanjaysubramanian.com/ideas/api/upload
curl.exe -s -w "`n%{http_code}`n" -H "Authorization: Bearer TOKEN" -F file=@big.wav https://sanjaysubramanian.com/ideas/api/upload
```
CHECK: first prints `401`; second prints `{"duplicate":false,"id":1}` then `201`.
Run the second again: `{"duplicate":true,"id":1}` then `200`.

### 11. Remove the test data (server)
```sh
doas -u _riffbox sqlite3 /var/riffbox/riffbox.db "DELETE FROM recordings;"
doas sh -c 'rm -f /var/riffbox/audio/*'
```
CHECK: `ls /var/riffbox/audio` prints nothing.

**Gate C (Phase 2 done): a 50 MB upload passes through relayd, dedupe works, 401 without the token.**

## Rollback
To remove **all** of Riffbox, not just undo the relayd change, use `deploy/UNINSTALL.md`.
Quick undo of only the public routing:
```sh
doas cp -p /etc/relayd.conf.bak /etc/relayd.conf
doas rcctl reload relayd
doas rcctl stop riffbox; doas rcctl disable riffbox
```

## Routine deploys (every future code update)

Whenever there is new code (a new phase, a fix), repeat the same steps. Nothing from the one-time
setup (5b, 5c, steps 1 to 4, 6 to 8) is ever repeated.

1. **Get the new code.** On the GitHub repository page: **Code → Download ZIP**.
2. **Replace your local folder.** Delete the old `C:\Users\YOURNAME\riffbox` folder, extract the new
   ZIP, and rename `riffbox-main` to `riffbox` at the **same location**. (Deleting first matters:
   if you extract on top of the old folder, files I removed would stay behind and keep being uploaded.
   Using the same location means your saved FreeFileSync setup still points at the right place.)
3. **Upload.** Double-click your saved `riffbox.ffs_gui`, click **COMPARE**, and check the list. You
   should see only the files that changed (for example a few "update" rows), not a wholesale
   re-upload. Then **SYNCHRONIZE → Start**.
4. **Install.** Log in to the server and run:
   ```sh
   sh ~/install-riffbox.sh
   ```
   CHECK: it ends with `deployed`.
5. **Confirm it's alive**, from your computer:
   ```powershell
   curl.exe -s https://sanjaysubramanian.com/ideas/health
   ```
   CHECK: `{"status":"ok"}`. Then reload https://sanjaysubramanian.com/ideas/ in your browser
   (Ctrl+F5 if the page looks unchanged).

What a deploy does and does not touch:

| Touched | Never touched |
|---|---|
| `/usr/local/riffbox` (the code) | `/var/riffbox` (your recordings and database) |
| the Riffbox service (restarted, about a second of downtime) | `/etc/riffbox.conf` (your secrets) |
| | relayd, httpd, certificates, mail, Radicale |

If I tell you a release also needs something else (a new package, a new line in
`/etc/riffbox.conf`, or a changed `deploy/rc.d/riffbox`), I'll say so explicitly, with the exact
commands. For a changed rc.d script the extra step is the `doas install ... /etc/rc.d/riffbox` line
from step 6, run before the final restart.

**If an upload goes wrong:** re-run FreeFileSync (it is safe to repeat), then
`sh ~/install-riffbox.sh` again. To go back to an older version, download that version's ZIP and
repeat the routine above.

(The repository also contains `deploy/deploy.sh` and `deploy/deploy.ps1`, scripts that do the same
thing from a terminal. They are optional and untested; FreeFileSync is the supported route.)

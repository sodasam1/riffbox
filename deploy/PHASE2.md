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

## First code upload (run on your computer, in the riffbox folder)

### 5. Windows PowerShell
```powershell
.\deploy\deploy.ps1 -Target HOST
```
(Mac/Linux: `RIFFBOX_HOST=HOST sh deploy/deploy.sh`.)
Expect it to fail at the very last step with "riffbox: not found" or similar, because the
service doesn't exist yet. That is fine: the files are already copied.
CHECK (on the server): `ls /usr/local/riffbox/app/riffbox` lists `__init__.py`, `config.py`, `schema.sql`.

## Start the service (server)

### 6. Install the rc.d script and start it
Copy `deploy/rc.d/riffbox` to the server (e.g. `scp deploy/rc.d/riffbox HOST:`), then:
```sh
doas install -m 555 -o root -g bin riffbox /etc/rc.d/riffbox
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

Only start this after Gate A. Back up first:
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
```sh
doas cp -p /etc/relayd.conf.bak /etc/relayd.conf
doas rcctl reload relayd
doas rcctl stop riffbox; doas rcctl disable riffbox
```

## Routine deploys afterwards
Just re-run step 5's command. It copies the code and restarts the service.

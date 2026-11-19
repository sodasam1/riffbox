# How login works, how to add it to an app, and how to scale it

> **Updated on branch `adopt-shared-kit-and-harden-login`.** Riffbox can now accept the server-wide login (section 6) and carries several safeguards from a
> security review (section 7). Sections 1-5 describe the older, per-app login, which is still the default (`RIFFBOX_AUTH=local`).

Written for the owner. Principles: use standard, long-lived parts; write as little security code as possible; keep everything at the
app level so the server as a whole depends on none of it; keep a clear path to something bigger.

## 1. What exists today
All of Riffbox's access control is in **one file, `app/riffbox/auth.py`**, plus the hashing in `app/riffbox/passwords.py` and the attempt limit in
`app/riffbox/throttle.py`. Nothing else in the app knows how login works.

| Way in | How | Standard part it relies on |
|---|---|---|
| The owner | `POST /api/login` with the passphrase, then a **signed session cookie** (`HttpOnly`, `Secure`, `SameSite=Lax`, scoped to `/ideas`, 60 days) | Flask's session (itsdangerous) |
| The phone Shortcut | `Authorization: Bearer <token>`; only the routes marked `allow_token` (upload, token-check); cannot read, change or export anything | a constant-time compare (`hmac.compare_digest`) |
| Anyone else | 401 | |

- **The passphrase is stored only as a salted hash** (`RIFFBOX_PASSPHRASE_HASH` in `/etc/riffbox.conf`), made by Werkzeug (installed with
  Flask). Method: scrypt (N=2^16, r=8, p=2) when Python's `hashlib` has it, otherwise PBKDF2-HMAC-SHA256 with 600,000 rounds. The method is written
  inside the hash string, so old hashes keep working if the method is changed later. The older plain `RIFFBOX_PASSPHRASE` still works for now,
  with a warning in the log, so an upgrade never locks you out; `deploy/install.sh --repair` converts it, after showing what it will do and asking (login stays the same).
- **Attempt limit:** 5 wrong passphrases per client (30 from anyone) per 15 minutes, then HTTP 429. In memory only (a restart clears it).
- **CSRF:** the `SameSite=Lax` cookie is the standard defence for a cookie login. The Bearer token is not sent automatically by browsers.
- **Changing the passphrase:** `printf '%s\n' 'new long passphrase' | python3 /usr/local/riffbox/deploy/hash_passphrase.py`, put the output
  in `/etc/riffbox.conf` as `RIFFBOX_PASSPHRASE_HASH=...`, `doas rcctl restart riffbox`. Existing logins stay valid until their cookies expire;
  to end them all, also change `RIFFBOX_SECRET` (the cookie-signing key).

## 2. Is this the standard way? (honest assessment)
- Login form + hashed password + signed cookie + attempt limit is the normal pattern for a web app. Guidance I found (secondary sources; the
  OWASP cheat sheets themselves were only partly retrievable): store only a slow salted hash (Argon2id first choice, scrypt next, bcrypt for old
  systems), cookies `HttpOnly`/`Secure`/`SameSite`, limit login attempts.
- Where it differs: **Argon2id is not used**, because it is not in Python's standard library or Werkzeug; scrypt/PBKDF2 are, and are
  long-lived. **Hash parameters were set from secondhand OWASP numbers and are unverified**: re-check them against the current OWASP Password
  Storage Cheat Sheet before relying on them, and raise them if the server can afford it.
- **Verified on the owner's OpenBSD 7.9 server:** its Python has no `hashlib.scrypt` (OpenBSD uses LibreSSL), so the PBKDF2-HMAC-SHA256 fallback with 600,000 rounds
  is what is in use (`python3 deploy/hash_passphrase.py --method` printed `pbkdf2:sha256:600000`). If scrypt ever becomes available, new hashes use it; old ones keep verifying.
- Single-user only. No password reset (you hold the server), no multi-factor, no per-session list, no logout-everywhere other than changing the secret.

## 3. Give a new Flask app a login (about 10 minutes)
1. Copy `auth.py`, `passwords.py` and `throttle.py` into the new app's package; they import only Flask and Werkzeug.
2. In the app factory: `auth = Auth(app, clock)`, `require_auth = auth.require`, `auth.register_routes(blueprint)`; decorate each route
   `@require_auth()` (or `@require_auth(allow_token=True)` for a token-only machine endpoint).
3. Set `SECRET_KEY`, `PASSPHRASE_HASH` (and `UPLOAD_TOKEN` if used) in the app's own conf file; cookie `SameSite=Lax`, `HttpOnly`, `Secure`, path scoped to the app.
4. Add a login page to the app's front end, and a test that every route returns 401 without a session (copy `test_security.py`).
5. Use the **same passphrase** by hashing it with the new app's `hash_passphrase.py`; each app has its own hash and cookie.

## 4. Scaling path (do not do early; each step has a trigger)
| Step | When | What changes | Server-level change? |
|---|---|---|---|
| **A. Now** | 1 or 2 apps | each app has its own `auth.py` (copy per section 3) | none |
| **B. Shared login module** | a third app, or you are tired of logging in separately | one login page and **one signed cookie scoped to `/`**, verified by every Flask app with the same `SECRET_KEY`; replace each app's `auth.py` body with a call into one shared file. The hash format is portable, so no password changes | none (all app-level) |
| **C. Forward-auth proxy** (Authelia-style) | several users, multi-factor authentication or passkeys | the proxy performs the login for every app and tells the app who the user is | **yes**: relayd cannot do forward auth, so a new front proxy or service is needed. Needs the owner's explicit approval and loses the Tech Independence "base tools only" property |
Because the interface is three functions (`require`, `register_routes`, `passphrase_ok`) and the hash string is self-describing, moving A -> B -> C
means replacing `auth.py`, not touching the rest of the app.

## 5. Static private pages
Plain files under `htdocs/private/` are protected by the web server itself (the site kit's `install.sh`: `authenticate` plus a bcrypt `htpasswd`
file), not by this code. Different purpose: that protects pages with no server code; this protects an app's data. The same passphrase can open both.

## 6. The site-wide login (new): `RIFFBOX_AUTH=local | both | site`
One central login service (personal-site `login/`, at `/login`) checks your passphrase once and sets one cookie **per app**, each signed with that app's own key
(`/etc/site-auth/keys/riffbox.key`, readable only by `_riffbox`). Riffbox verifies `site_riffbox` with `siteauth` (vendored in `app/siteauth/`). Full design:
personal-site `docs/MULTI-APP.md`.
| `RIFFBOX_AUTH` | Meaning |
|---|---|
| `local` (default) | exactly as before: Riffbox's own passphrase and cookie. The site cookie is ignored. |
| `both` | either works. Use while moving over. |
| `site` | only the site login. `POST /api/login` answers 410 and the page sends you to `/login?next=/ideas/`. |
To move over: install the login service (personal-site `RESTORE.html` B2), re-run `doas sh ~/riffbox/deploy/install.sh` (it registers Riffbox and writes its key; held back with a
message if the login is not installed yet), add `RIFFBOX_AUTH=both` to `/etc/riffbox.conf`, `doas rcctl restart riffbox`, sign in at `/login`, check `/ideas/`, then set `site`.
Back out at any time by setting it back to `local`. The phone upload token is unaffected in every mode. "Log out everywhere": `keys.py rotate` (see MULTI-APP.md).

## 7. Safeguards added after the security review (all modes)
- A stranger can no longer lock you out: the old 30-failures-from-anyone rule made every login answer 429; now it only slows attempts (2 s each, at most 2 waiting at once). The per-client limit (5 wrong tries per 15 min by default) is unchanged unless you set `RIFFBOX_LOGIN_MAX_FAILS` and `RIFFBOX_LOGIN_WINDOW_MINUTES` in `/etc/riffbox.conf` (then `doas rcctl restart riffbox`); the slow lane for spread-out attacks never locks anyone out and is not affected.
- `/api/login` reads at most 4 KB (it used to accept up to the app-wide 300 MB before checking anything).
- Wrong upload tokens are counted: 20 per client per 15 min, then that client is refused.
- State-changing requests that a browser says came from another origin get 403 (on top of `SameSite=Lax`). Requests with no `Origin` (Shortcut, curl) are unaffected.
- A strict Content-Security-Policy (`script-src 'self'`, no inline script, `frame-ancestors 'none'`); the looser site-wide one in relayd stays, and the stricter one wins.
- Passphrase minimum is 15 characters (NIST SP 800-63B-4 for a password used alone) when choosing one; an older shorter one still verifies, with a note.
- Cookie lifetime 30 days (was 60).
- **Not changed, on purpose:** the old plain-text `RIFFBOX_PASSPHRASE` setting is still accepted (removing it would lock you out if the live conf still has it; `--repair` converts it, then it can be removed in a later change).

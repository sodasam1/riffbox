"""Key handling for siteauth. Standard library only, so the installers can run it with nothing but python3.

Files (all under /etc/site-auth, written by root):
  master            random 64 hex characters; readable only by the login service
  generation        a whole number; bump it to log every device out of every app (installer: `rotate`)
  apps.conf         one line per app:  <unixname> <cookie path>      e.g.  riffbox /ideas
  keys/<unixname>.key   that app's own signing key = HMAC-SHA256(master, "<unixname>|<generation>"), readable by that app only
  passphrase.hash   the one salted hash of your passphrase (login service only)

Run as a script (by deploy/appkit.sh):  python3 keys.py ensure-app --dir D --app NAME --path /p --user _name
"""
import argparse
import hashlib
import hmac
import os
import re
import secrets
import sys

NAME_RE = re.compile(r"^[a-z0-9]+$")
PATH_RE = re.compile(r"^/[a-z0-9-]*$")


def derive(master, app, generation):
    """The one definition of an app's key. The login service and the installers both call this."""
    return hmac.new(master.encode(), f"{app}|{int(generation)}".encode(), hashlib.sha256).hexdigest()


def read_first_line(path, default=None):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.readline().strip()
    except OSError:
        return default


def read_apps(directory):
    """[(name, path), ...] from apps.conf; bad lines are skipped, never trusted."""
    out = []
    try:
        with open(os.path.join(directory, "apps.conf"), encoding="utf-8") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) == 2 and NAME_RE.match(parts[0]) and PATH_RE.match(parts[1]):
                    out.append((parts[0], parts[1]))
    except OSError:
        pass
    return out


class KeyFile:
    """An app's key, re-read when the file changes (so `rotate` needs no restart). None if missing: then no cookie is valid."""
    def __init__(self, path):
        self.path = path
        self._mtime = None
        self._value = None

    def get(self):
        try:
            m = os.stat(self.path).st_mtime_ns
        except OSError:
            self._mtime, self._value = None, None
            return None
        if m != self._mtime:
            self._value = read_first_line(self.path) or None
            self._mtime = m
        return self._value


def _write(path, text, mode, group=None):
    """Write atomically with the given mode; if `group` is given, root:group ownership (the group has the same name as the service user)."""
    tmp = path + ".new"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w") as fh:
        fh.write(text)
    os.chmod(tmp, mode)
    if group:
        import grp
        os.chown(tmp, 0, grp.getgrnam(group).gr_gid)
    os.replace(tmp, path)


def ensure_app(directory, app, path, user=None, chown=True):
    """Register the app and write its key file. Idempotent. Returns a short report; raises SystemExit(3) if the login service is
    not installed yet (no master file)."""
    if not NAME_RE.match(app) or not PATH_RE.match(path):
        raise SystemExit("bad app name or path")
    master = read_first_line(os.path.join(directory, "master"))
    if not master:
        raise SystemExit(3)
    gen = read_first_line(os.path.join(directory, "generation"), "1")
    report = []
    lines = []
    try:
        with open(os.path.join(directory, "apps.conf"), encoding="utf-8") as fh:
            lines = [ln.rstrip("\n") for ln in fh]
    except OSError:
        pass
    want = f"{app} {path}"
    kept = [ln for ln in lines if ln.split()[:1] != [app]]
    if want not in lines:
        _write(os.path.join(directory, "apps.conf"), "\n".join(kept + [want]) + "\n", 0o640, "_sitelogin" if chown else None)
        report.append("registered in apps.conf")
    kdir = os.path.join(directory, "keys")
    os.makedirs(kdir, mode=0o755, exist_ok=True)
    kpath = os.path.join(kdir, app + ".key")
    value = derive(master, app, gen)
    if read_first_line(kpath) != value:
        _write(kpath, value + "\n", 0o640, user if chown else None)
        report.append("key file written")
    return report or ["already registered, key current"]


def main(argv=None):
    p = argparse.ArgumentParser(prog="keys.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("ensure-app")
    e.add_argument("--dir", required=True)
    e.add_argument("--app", required=True)
    e.add_argument("--path", required=True)
    e.add_argument("--user", default=None)
    e.add_argument("--no-chown", action="store_true")
    i = sub.add_parser("init")
    i.add_argument("--dir", required=True)
    i.add_argument("--no-chown", action="store_true")
    r = sub.add_parser("rotate")
    r.add_argument("--dir", required=True)
    a = p.parse_args(argv)
    if a.cmd == "ensure-app":
        for line in ensure_app(a.dir, a.app, a.path, a.user, not a.no_chown):
            print(line)
    elif a.cmd == "init":
        os.makedirs(a.dir, mode=0o755, exist_ok=True)
        made = []
        for fn, val in (("master", secrets.token_hex(32)), ("generation", "1")):
            fp = os.path.join(a.dir, fn)
            if not os.path.exists(fp):
                _write(fp, val + "\n", 0o600 if fn == "master" else 0o640, "_sitelogin" if not a.no_chown else None)
                made.append(fn)
        print("created: " + ", ".join(made) if made else "already initialised")
    elif a.cmd == "rotate":
        gp = os.path.join(a.dir, "generation")
        gen = int(read_first_line(gp, "1")) + 1
        _write(gp, f"{gen}\n", 0o640, None)
        master = read_first_line(os.path.join(a.dir, "master"))
        for app, _path in read_apps(a.dir):
            _write(os.path.join(a.dir, "keys", app + ".key"), derive(master, app, gen) + "\n", 0o640, None)
        print(f"generation is now {gen}: every device is logged out of every app (owners of key files unchanged)")


if __name__ == "__main__":
    sys.exit(main())

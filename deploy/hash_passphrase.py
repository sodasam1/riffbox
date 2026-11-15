#!/usr/bin/env python3
"""Turns a Riffbox passphrase into the salted hash that goes in /etc/riffbox.conf. Needs only Python and Werkzeug (installed with Flask).

    printf '%s\\n' 'your passphrase' | python3 hash_passphrase.py      prints the hash (this is how install.sh uses it)
    python3 hash_passphrase.py --method                              prints which hash method this server will use
    python3 hash_passphrase.py --upgrade-conf /etc/riffbox.conf      replaces an old plain-text RIFFBOX_PASSPHRASE line
                                                                     with RIFFBOX_PASSPHRASE_HASH (the login stays the same)
The hash is written by app/riffbox/passwords.py; read its header for the method and why.
"""
import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True          # no __pycache__ next to the source: run as root, it would leave root-owned files in the upload folder
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _shared import load  # noqa: E402

passwords = load("passwords")


def upgrade_conf(path):
    path = Path(path)
    lines = path.read_text().splitlines()
    plain_at = next((i for i, l in enumerate(lines) if l.startswith("RIFFBOX_PASSPHRASE=")), None)
    has_hash = any(l.startswith("RIFFBOX_PASSPHRASE_HASH=") for l in lines)
    if plain_at is None:
        print("no plain-text passphrase in", path)
        return 0
    value = lines[plain_at].partition("=")[2].strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    if has_hash:
        del lines[plain_at]
        print("a hash was already present: removed the plain-text line")
    else:
        if len(value) < passwords.MIN_LENGTH:
            print(f"NOTE: your current passphrase is shorter than {passwords.MIN_LENGTH} characters. It still works; consider a longer one.",
                  file=sys.stderr)
        lines[plain_at] = "RIFFBOX_PASSPHRASE_HASH=" + passwords.hash_passphrase(value, check_length=False)
        print("replaced the plain-text passphrase with a", passwords.default_method().split(":")[0], "hash")
    # Written as a new file and then renamed over the old one, so a crash half-way can never leave a damaged settings file. Owner and mode are copied
    # across (root:_riffbox, 640); the owner copy needs root, which is how the installer runs it.
    st = path.stat()
    tmp = path.with_name(path.name + ".new")
    try:
        with open(tmp, "w") as fh:
            fh.write("\n".join(lines) + "\n")
        os.chmod(tmp, st.st_mode & 0o777)
        try:
            os.chown(tmp, st.st_uid, st.st_gid)
        except PermissionError:
            pass
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()
    return 0


def main(argv):
    if argv[:1] == ["--method"]:
        print(passwords.default_method())
        return 0
    if argv[:1] == ["--upgrade-conf"] and len(argv) == 2:
        return upgrade_conf(argv[1])
    if argv:
        print(__doc__, file=sys.stderr)
        return 2
    passphrase = sys.stdin.readline().rstrip("\n")
    try:
        print(passwords.hash_passphrase(passphrase))
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

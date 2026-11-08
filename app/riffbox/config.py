"""Tiny KEY=VALUE config-file loader, so secrets live in a root-owned file
(/etc/riffbox.conf, mode 640 root:_riffbox) instead of in rc.d flags or the
process list. Real environment variables win over the file."""
import os


def parse_config(text):
    out = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key.strip()] = value
    return out


def load_config_file(path=None):
    path = path or os.environ.get("RIFFBOX_CONFIG", "/etc/riffbox.conf")
    try:
        with open(path) as fh:
            values = parse_config(fh.read())
    except FileNotFoundError:
        return False
    for key, value in values.items():
        os.environ.setdefault(key, value)
    return True

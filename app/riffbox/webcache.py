"""Smaller and cached: compression for text answers, and page files that the browser can keep for a year.

Standard library only (no Flask). waitress and relayd do not compress, so the app does it, with Python's own gzip.

  * Answers that are text (JSON, HTML, CSS, JavaScript) are sent gzip-compressed when the browser accepts it. Audio and the
    streamed export are never touched.
  * index.html is rewritten when it is served so each page file's address carries a fingerprint of its content
    ("static/app.js?v=3f9a1c0b2d44"). A fingerprinted address never changes meaning, so it is cached for a year; a new
    version of a file has a new fingerprint, so the browser fetches it at once. The page itself is always re-checked (a tiny
    "not modified" answer when nothing changed). No build step: the fingerprint is worked out here, from the file.
"""
import gzip
import hashlib
import re

COMPRESSIBLE = ("application/json", "text/html", "text/css", "text/javascript", "application/javascript", "text/plain", "text/csv")
MIN_SIZE = 600                      # below this a gzip saves almost nothing
ONE_YEAR = 31536000
LINK = re.compile(r'(?P<attr>(?:src|href)=")static/(?P<name>[A-Za-z0-9_.-]+)(?P<end>")')


def accepts_gzip(header):
    """True if an Accept-Encoding header allows gzip (named, or by "*") with a quality above zero."""
    allowed = False
    for part in (header or "").lower().split(","):
        name, _, params = part.partition(";")
        name, q = name.strip(), 1.0
        for item in params.split(";"):
            key, _, value = item.strip().partition("=")
            if key == "q":
                try:
                    q = float(value)
                except ValueError:
                    q = 0.0
        if name in ("gzip", "x-gzip") or (name == "*" and not allowed):
            allowed = q > 0
            if name != "*":
                return allowed
    return allowed


def should_compress(mimetype, status, size, already_encoded):
    return status == 200 and not already_encoded and (mimetype or "") in COMPRESSIBLE and size >= MIN_SIZE


def squeeze(data):
    return gzip.compress(data, compresslevel=5, mtime=0)


class PageFiles:
    """The page files of a static folder: their bytes, gzip copies and fingerprints, re-read when a file changes."""

    def __init__(self, folder):
        self.folder = folder
        self._seen = {}                                  # path -> (mtime_ns, size, bytes, gzipped, fingerprint)

    def read(self, name):
        """(bytes, gzipped bytes, fingerprint) for a file directly inside the folder, or None."""
        if "/" in name or "\\" in name or name.startswith("."):
            return None
        path = self.folder / name
        try:
            st = path.stat()
        except OSError:
            return None
        if not path.is_file():
            return None
        known = self._seen.get(name)
        if known and known[0] == st.st_mtime_ns and known[1] == st.st_size:
            return known[2:]
        data = path.read_bytes()
        entry = (st.st_mtime_ns, st.st_size, data, squeeze(data), hashlib.sha256(data).hexdigest()[:12])
        self._seen[name] = entry
        return entry[2:]

    def index(self):
        """index.html with every static link carrying the fingerprint of the file it points to, and that page's own fingerprint."""
        page = self.read("index.html")
        if page is None:
            return None

        def link(m):
            f = self.read(m.group("name"))
            return m.group(0) if f is None else f'{m.group("attr")}static/{m.group("name")}?v={f[2]}{m.group("end")}'
        body = LINK.sub(link, page[0].decode("utf-8")).encode("utf-8")
        return body, hashlib.sha256(body).hexdigest()[:16]

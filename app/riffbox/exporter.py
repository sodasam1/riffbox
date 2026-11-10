"""Export: turn the data directory into plain, portable files. Standard library only, no Flask.

One recipe, two outputs: a folder on disk (deploy/export.py, for the command line) or a zip streamed to the
browser (the "Backup and export" page). Both are driven by the same `pump()` so they cannot drift apart.

What comes out (see README.txt inside every export):
  recordings/   each original audio file under a readable name ("2026-03-01 Title [12].m4a") with a matching
                note ("... [12].md": details at the top, your notes below; an Obsidian vault opens it as it is).
                An idea made of several recordings has ONE note ("2026-03-01 Title [idea 7].md": the idea's details,
                its parts and the tempo or key choices still open) and one audio file per part, named
                "2026-03-01 Title - part 2 Drums [13].m4a", so the association survives without the database.
  index.html    every recording with a play control (works from a double-click, no server)
  index.csv     the same list for a spreadsheet
  riffbox.db    a consistent copy of the database
  manifest-sha256.txt   a checksum of every file (`sha256sum -c` reads it)
  PROBLEMS.txt  only if something was wrong (a missing or damaged audio file)
The originals are only read, never changed. FLAC play copies are left out: they can be rebuilt.
"""
import csv
import functools
import hashlib
import html
import io
import json
import os
import re
import shutil
import sqlite3
import tempfile
import time
import zipfile
from pathlib import Path

CHUNK = 1 << 20
WINDOWS_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
MARKS = {"heart": "♥", "check": "✓", "x": "✗"}

README = (
    "RIFFBOX EXPORT\n==============\n"
    "recordings/  your original audio files with readable names; each has a .md note beside it\n"
    "             (details between the --- lines, your notes below). Plain text: any editor opens it.\n"
    "             An idea made of several recordings has one note ([idea N]) and its parts are named 'part 1', 'part 2', ...\n"
    "index.html   open in a web browser to see and play everything (no server needed)\n"
    "index.csv    the same list for a spreadsheet\n"
    "riffbox.db   the complete database, in SQLite format (any SQLite tool opens it)\n"
    "manifest-sha256.txt  checksums; on Linux/macOS/BSD run `sha256sum -c manifest-sha256.txt` (or `shasum -a 256 -c`)\n"
    "The audio files are untouched copies of what was uploaded (m4a, wav, mp3, flac, ...).\n"
)


def safe_name(title, limit=80):
    name = WINDOWS_BAD.sub("_", " ".join(title.split())).strip(" .") or "untitled"
    return name[:limit].rstrip(" .")


def _q(value):
    """A YAML-safe double-quoted string (JSON strings are valid YAML)."""
    return json.dumps(value, ensure_ascii=False)


def _key_text(r):
    return " ".join(x for x in (r["key_root"], r["key_mode"]) if x)


def _note_text(r, tags, audio_name):
    lines = ["---", f"title: {_q(r['title'])}", f"recorded: {_q(r['recorded_at'])}", f"uploaded: {_q(r['uploaded_at'])}",
             f"status: {'inbox' if r['status'] == 'inbox' else 'library'}"]
    if r["bpm"]:
        lines.append(f"bpm: {r['bpm']}")
    if _key_text(r):
        lines.append(f"key: {_q(_key_text(r))}")
    if r["rating"]:
        lines.append(f"mark: {r['rating']}")
    if r["used_in"]:
        lines.append(f"used_in: {_q(r['used_in'])}")
    lines.append("tags: [" + ", ".join(_q(t) for t in tags) + "]")
    lines += [f"audio: {_q(audio_name)}", f"sha256: {_q(r['sha256'])}", "---", "", f"![[{audio_name}]]", ""]
    if r["notes"]:
        lines += [r["notes"], ""]
    return "\n".join(lines)


def _idea_note_text(idea, files):
    """One note for an idea of several recordings: the idea's details, then each part."""
    r, parts = idea["g"], idea["parts"]
    lines = ["---", f"title: {_q(r['title'])}", f"recorded: {_q(r['recorded_at'])}", f"uploaded: {_q(r['uploaded_at'])}",
             f"status: {'inbox' if r['status'] == 'inbox' else 'library'}"]
    if r["bpm"]:
        lines.append(f"bpm: {r['bpm']}")
    if _key_text(r):
        lines.append(f"key: {_q(_key_text(r))}")
    for kind, options in (idea.get("unresolved") or {}).items():          # tempo or key the parts disagreed on, still to be chosen
        texts = [(f"{o['value']} BPM" if kind == "bpm" else " ".join(x for x in (o.get("key_root"), o.get("key_mode")) if x))
                 + " (" + ", ".join(o.get("from", [])) + ")" for o in options]
        lines.append(f"{kind}_still_to_choose: [" + ", ".join(_q(t) for t in texts) + "]")
    if r["rating"]:
        lines.append(f"mark: {r['rating']}")
    if r["used_in"]:
        lines.append(f"used_in: {_q(r['used_in'])}")
    lines.append("tags: [" + ", ".join(_q(t) for t in idea["tags"]) + "]")
    lines.append("parts:")
    for part, name in files:
        lines += [f"  - label: {_q(part['title'])}", f"    audio: {_q(name)}", f"    sha256: {_q(part['sha256'])}"]
    lines += ["---", ""]
    lines += [f"![[{name}]]" for _p, name in files]
    lines.append("")
    if r["notes"]:
        lines += [r["notes"], ""]
    return "\n".join(lines)


def _csv_bytes(ideas):
    """One row per recording. The details are the idea's; the last columns say which idea and part a recording is."""
    buf = io.StringIO(newline="")
    w = csv.writer(buf)
    w.writerow(["id", "title", "audio_file", "recorded", "uploaded", "status", "bpm", "key", "mark", "used_in",
                "tags", "notes", "sha256", "idea_id", "idea_parts", "part", "part_title"])
    for idea in ideas:
        g, many = idea["g"], len(idea["parts"]) > 1
        for n, (r, name) in enumerate(idea["files"], 1):
            w.writerow([r["id"], g["title"], "recordings/" + name, g["recorded_at"], g["uploaded_at"], g["status"],
                        g["bpm"] or "", _key_text(g), g["rating"] or "", g["used_in"] or "", "; ".join(idea["tags"]), g["notes"],
                        r["sha256"], idea["id"], len(idea["parts"]), n if many else "", r["title"] if many else ""])
    return ("\ufeff" + buf.getvalue()).encode("utf-8")        # BOM so Excel reads accents


def _href(name):
    return "recordings/" + name.replace("%", "%25").replace("#", "%23").replace("?", "%3F").replace(" ", "%20")


def _html_bytes(ideas):
    body = []
    for idea in ideas:
        g = idea["g"]
        extra = " · ".join(x for x in (f"{g['bpm']} BPM" if g["bpm"] else "", _key_text(g), MARKS.get(g["rating"], ""),
                                       f"used in {g['used_in']}" if g["used_in"] else "") if x)
        players = []
        for r, name in idea["files"]:
            label = f"{html.escape(r['title'])}<br>" if len(idea["parts"]) > 1 else ""
            players.append(f"{label}<audio controls preload=\"none\" src=\"{_href(name)}\"></audio> <a href=\"{_href(name)}\">file</a>")
        body.append(
            f"<tr><td>{html.escape(g['recorded_at'][:10])}</td><td><strong>{html.escape(g['title'])}</strong><br>"
            + "<br>".join(players) + "</td>"
            f"<td>{html.escape(extra)}</td><td>{html.escape(', '.join(idea['tags']))}</td>"
            f"<td style=\"white-space:pre-wrap\">{html.escape(g['notes'])}</td></tr>")
    count = sum(len(i["files"]) for i in ideas)
    return (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" "
        "content=\"width=device-width,initial-scale=1\"><title>Riffbox export</title><style>"
        "body{font:16px/1.4 system-ui,sans-serif;margin:1rem auto;max-width:70rem;padding:0 1rem}"
        "td,th{padding:.4rem .6rem;border-bottom:1px solid #8884;text-align:left;vertical-align:top}"
        "audio{max-width:100%}</style></head><body><h1>Riffbox export</h1>"
        f"<p>{len(ideas)} ideas, {count} recordings. Open a recording's file or press play; nothing here needs a server.</p>"
        "<table><thead><tr><th>Recorded</th><th>Recording</th><th>Details</th><th>Tags</th><th>Notes</th></tr></thead><tbody>"
        + "\n".join(body) + "</tbody></table></body></html>\n").encode("utf-8")


def snapshot_database(data_dir, target):
    """A consistent copy of the live database (safe while the app is running)."""
    src, dst = sqlite3.connect(Path(data_dir) / "riffbox.db"), sqlite3.connect(target)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_ideas(snap, include_trash):
    """The ideas to export, each {"id", "g": the idea's details, "tags", "parts": [recording rows], "unresolved"}. A database from
    before groups existed has no ideas: every recording is then an idea of its own, exactly as it always was."""
    has_groups = snap.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'idea_groups'").fetchone()
    ideas = []
    if not has_groups:
        where = "" if include_trash else "WHERE deleted_at IS NULL"
        tags = {}
        for t in snap.execute("SELECT rt.recording_id, rt.tag FROM recording_tags rt JOIN tags t ON t.name = rt.tag ORDER BY t.rowid"):
            tags.setdefault(t["recording_id"], []).append(t["tag"])
        for r in snap.execute(f"SELECT * FROM recordings {where} ORDER BY recorded_at, id"):
            ideas.append({"id": r["id"], "g": r, "tags": tags.get(r["id"], []), "parts": [r], "unresolved": None})
        return ideas
    where = "" if include_trash else "WHERE g.deleted_at IS NULL"
    tags = {}
    for t in snap.execute("SELECT gt.group_id, gt.tag FROM group_tags gt JOIN tags t ON t.name = gt.tag ORDER BY t.rowid"):
        tags.setdefault(t["group_id"], []).append(t["tag"])
    parts = {}
    for r in snap.execute("SELECT * FROM recordings WHERE group_id IS NOT NULL ORDER BY group_id, position, id"):
        parts.setdefault(r["group_id"], []).append(r)
    for g in snap.execute(f"SELECT g.* FROM idea_groups g {where} ORDER BY g.recorded_at, g.id"):
        if g["id"] in parts:
            ideas.append({"id": g["id"], "g": g, "tags": tags.get(g["id"], []), "parts": parts[g["id"]],
                          "unresolved": json.loads(g["unresolved"]) if g["unresolved"] else None})
    return ideas


def iter_items(data_dir, include_trash, scratch, problems):
    """Yield (archive_name, payload, expected_sha256): payload is bytes, or a Path to copy. `problems` is a list
    that this generator and pump() add warnings to. The database snapshot lives in `scratch` until finished."""
    data_dir, scratch = Path(data_dir), Path(scratch)
    scratch.mkdir(parents=True, exist_ok=True)
    snap_path = Path(tempfile.mkdtemp(prefix="export-", dir=scratch)) / "riffbox.db"
    try:
        snapshot_database(data_dir, snap_path)
        snap = sqlite3.connect(snap_path)
        snap.row_factory = sqlite3.Row
        ideas = _load_ideas(snap, include_trash)
        snap.close()

        for idea in ideas:                                    # name the files, leave out any whose audio is missing
            g, many = idea["g"], len(idea["parts"]) > 1
            idea["files"] = []
            for n, r in enumerate(idea["parts"], 1):
                if not (data_dir / "audio" / r["filename"]).is_file():
                    problems.append(f"missing audio file for recording {r['id']} ({r['title']}): {r['filename']}")
                    continue
                day, ext = g["recorded_at"][:10], Path(r["filename"]).suffix
                name = (f"{day} {safe_name(g['title'], 60)} - part {n} {safe_name(r['title'], 40)} [{r['id']}]{ext}" if many
                        else f"{day} {safe_name(g['title'])} [{r['id']}]{ext}")
                idea["files"].append((r, name))
        ideas = [i for i in ideas if i["files"]]

        yield "README.txt", README.encode("utf-8"), None
        yield "index.html", _html_bytes(ideas), None
        yield "index.csv", _csv_bytes(ideas), None
        for idea in ideas:
            for r, name in idea["files"]:
                yield "recordings/" + name, data_dir / "audio" / r["filename"], r["sha256"]
            if len(idea["parts"]) > 1:
                note = f"{idea['g']['recorded_at'][:10]} {safe_name(idea['g']['title'])} [idea {idea['id']}].md"
                yield "recordings/" + note, _idea_note_text(idea, idea["files"]).encode("utf-8"), None
            else:
                r, name = idea["files"][0]
                details = {**dict(idea["g"]), "sha256": r["sha256"]}     # the idea's details (an idea of one is the same as its recording)
                yield "recordings/" + name[:name.rindex(".")] + ".md", _note_text(details, idea["tags"], name).encode("utf-8"), None
        yield "riffbox.db", snap_path, None
    finally:
        shutil.rmtree(snap_path.parent, ignore_errors=True)


def pump(data_dir, include_trash, scratch):
    """Drive iter_items and produce a flat stream of events for a sink:
    ("start", name, size_or_None, mtime) / ("chunk", bytes) / ("end",). Appends PROBLEMS.txt (if any) and
    manifest-sha256.txt last. A file that disagrees with the checksum recorded at upload is still exported."""
    problems, hashes = [], {}
    items = iter_items(data_dir, include_trash, scratch, problems)

    def emit_bytes(name, data):
        hashes[name] = hashlib.sha256(data).hexdigest()
        yield "start", name, len(data), time.time()
        yield "chunk", data
        yield "end",

    try:
        for name, payload, expected in items:
            if isinstance(payload, bytes):
                yield from emit_bytes(name, payload)
                continue
            try:
                fh = open(payload, "rb")
            except OSError as exc:
                problems.append(f"could not read {payload.name}: {exc}")
                continue
            with fh:
                h = hashlib.sha256()
                yield "start", name, payload.stat().st_size, payload.stat().st_mtime
                for chunk in iter(functools.partial(fh.read, CHUNK), b""):
                    h.update(chunk)
                    yield "chunk", chunk
                yield "end",
            hashes[name] = h.hexdigest()
            if expected and h.hexdigest() != expected:
                problems.append(f"checksum differs from the one stored at upload for {name} (the file may be damaged)")
        if problems:
            yield from emit_bytes("PROBLEMS.txt", ("\n".join(problems) + "\n").encode("utf-8"))
        lines = "".join(f"{digest}  {name}\n" for name, digest in sorted(hashes.items()))
        yield from emit_bytes("manifest-sha256.txt", lines.encode("utf-8"))
    finally:
        items.close()
    return problems


def export_to_folder(data_dir, out_dir, include_trash=False, scratch=None):
    """Write the export into a new, empty folder. Returns (recording_count, problems)."""
    out_dir = Path(out_dir)
    if out_dir.exists() and any(out_dir.iterdir()):
        raise ValueError(f"{out_dir} already exists and is not empty; choose a new folder")
    if not (Path(data_dir) / "riffbox.db").is_file():
        raise ValueError(f"no riffbox.db in {data_dir}")
    out_dir.mkdir(parents=True, exist_ok=True)
    scratch = scratch or out_dir.parent / (out_dir.name + ".tmp")
    out = None
    problems = []
    gen = pump(data_dir, include_trash, scratch)
    try:
        while True:
            try:
                ev = next(gen)
            except StopIteration as stop:
                problems = stop.value or []
                break
            if ev[0] == "start":
                target = out_dir / ev[1]
                target.parent.mkdir(parents=True, exist_ok=True)
                out = open(target, "wb")
                src_mtime = ev[3]
            elif ev[0] == "chunk":
                out.write(ev[1])
            else:
                out.close()
                os.utime(target, (src_mtime, src_mtime))
    finally:
        gen.close()
        shutil.rmtree(scratch, ignore_errors=True)
    count = sum(1 for p in (out_dir / "recordings").glob("*.md")) if (out_dir / "recordings").is_dir() else 0
    return count, problems


class _Pipe:
    """A write-only target for zipfile that hands back what was written, so a zip can be streamed."""

    def __init__(self):
        self.parts, self.pos = [], 0

    def write(self, data):
        self.parts.append(bytes(data))
        self.pos += len(data)
        return len(data)

    def flush(self):
        pass

    def tell(self):
        return self.pos

    def drain(self):
        data, self.parts = b"".join(self.parts), []
        return data


def stream_zip(data_dir, include_trash=False, scratch=None, folder="riffbox-export"):
    """Yield the bytes of a zip file holding the export, produced as it goes (nothing is built on disk or in
    memory beyond one chunk). Audio is stored, not compressed: it is already compressed."""
    pipe = _Pipe()
    zf = zipfile.ZipFile(pipe, "w", zipfile.ZIP_STORED, allowZip64=True)
    scratch = scratch or tempfile.gettempdir()
    gen = pump(data_dir, include_trash, scratch)
    entry = None
    try:
        for ev in gen:
            if ev[0] == "start":
                stamp = time.localtime(max(ev[3], 315532800))[:6]          # zip cannot hold dates before 1980
                info = zipfile.ZipInfo(f"{folder}/{ev[1]}", stamp)
                info.compress_type = zipfile.ZIP_STORED
                info.external_attr = 0o644 << 16
                entry = zf.open(info, "w", force_zip64=True)
            elif ev[0] == "chunk":
                entry.write(ev[1])
                data = pipe.drain()
                if data:
                    yield data
            else:
                entry.close()
                entry = None
        zf.close()
        yield pipe.drain()
    finally:
        gen.close()


def stream_files_zip(files, folder):
    """Yield the bytes of a zip holding `files` ([(name inside the zip, Path)]) under one top folder, produced as it goes.
    Used for "download all parts" of an idea. Audio is stored, not compressed: it is already compressed."""
    pipe = _Pipe()
    zf = zipfile.ZipFile(pipe, "w", zipfile.ZIP_STORED, allowZip64=True)
    for name, path in files:
        st = path.stat()
        info = zipfile.ZipInfo(f"{folder}/{name}", time.localtime(max(st.st_mtime, 315532800))[:6])
        info.compress_type = zipfile.ZIP_STORED
        info.external_attr = 0o644 << 16
        with open(path, "rb") as src, zf.open(info, "w", force_zip64=True) as entry:
            for chunk in iter(functools.partial(src.read, CHUNK), b""):
                entry.write(chunk)
                data = pipe.drain()
                if data:
                    yield data
    zf.close()
    yield pipe.drain()

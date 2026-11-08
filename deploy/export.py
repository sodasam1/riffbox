#!/usr/bin/env python3
"""Riffbox export: turn the data directory into a folder you can read with nothing but a file manager,
a text editor and a web browser. Standard library only, and it never imports Riffbox itself, so it keeps
working even if the app or Flask is gone.

    python3 export.py /var/riffbox /path/to/new-export-folder [--include-trash]

Makes, inside the new folder:
  recordings/   each original audio file under a readable name ("2026-03-01 Title [12].m4a") with a
                matching note next to it ("... [12].md": details at the top, your notes below; an
                Obsidian vault can open the folder as it is)
  index.html    every recording with a play control; double-click it, no server needed
  index.csv     the same list for a spreadsheet
  riffbox.db    a consistent copy of the database (open with any SQLite tool)
  manifest-sha256.txt   a checksum of every file, in the format `sha256sum -c` reads
  README.txt    what all this is
The original files are copied, never changed or removed. FLAC play copies are left out (they can be
made again from the originals).
"""
import argparse
import csv
import hashlib
import html
import json
import re
import shutil
import sqlite3
import sys
from pathlib import Path

WINDOWS_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_name(title, limit=80):
    name = WINDOWS_BAD.sub("_", " ".join(title.split())).strip(" .") or "untitled"
    return name[:limit].rstrip(" .")


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def q(value):
    """A YAML-safe double-quoted string (JSON strings are valid YAML)."""
    return json.dumps(value, ensure_ascii=False)


def key_text(r):
    return " ".join(x for x in (r["key_root"], r["key_mode"]) if x)


def note_text(r, tags, audio_name):
    lines = ["---", f"title: {q(r['title'])}", f"recorded: {q(r['recorded_at'])}", f"uploaded: {q(r['uploaded_at'])}",
             f"status: {'inbox' if r['status'] == 'inbox' else 'library'}"]
    if r["bpm"]:
        lines.append(f"bpm: {r['bpm']}")
    if key_text(r):
        lines.append(f"key: {q(key_text(r))}")
    if r["rating"]:
        lines.append(f"mark: {r['rating']}")
    if r["used_in"]:
        lines.append(f"used_in: {q(r['used_in'])}")
    lines.append("tags: [" + ", ".join(q(t) for t in tags) + "]")
    lines += [f"audio: {q(audio_name)}", f"sha256: {q(r['sha256'])}", "---", "", f"![[{audio_name}]]", ""]
    if r["notes"]:
        lines += [r["notes"], ""]
    return "\n".join(lines)


def export(data_dir, out_dir, include_trash=False):
    data_dir, out_dir = Path(data_dir), Path(out_dir)
    db_file = data_dir / "riffbox.db"
    if not db_file.is_file():
        raise SystemExit(f"no riffbox.db in {data_dir}")
    if out_dir.exists() and any(out_dir.iterdir()):
        raise SystemExit(f"{out_dir} already exists and is not empty; choose a new folder")
    rec_dir = out_dir / "recordings"
    rec_dir.mkdir(parents=True, exist_ok=True)

    src, snap = sqlite3.connect(db_file), sqlite3.connect(out_dir / "riffbox.db")
    src.backup(snap)                        # a consistent copy, even while the app is running
    src.close()
    snap.row_factory = sqlite3.Row
    where = "" if include_trash else "WHERE deleted_at IS NULL"
    rows = snap.execute(f"SELECT * FROM recordings {where} ORDER BY recorded_at, id").fetchall()
    tags = {}
    for t in snap.execute("SELECT rt.recording_id, rt.tag FROM recording_tags rt JOIN tags t ON t.name = rt.tag"
                          " ORDER BY t.rowid"):
        tags.setdefault(t["recording_id"], []).append(t["tag"])

    problems, listing = [], []
    for r in rows:
        original = data_dir / "audio" / r["filename"]
        ext = Path(r["filename"]).suffix
        stem = f"{r['recorded_at'][:10]} {safe_name(r['title'])} [{r['id']}]"
        audio_name = stem + ext
        if not original.is_file():
            problems.append(f"missing audio file for recording {r['id']} ({r['title']}): {r['filename']}")
            continue
        shutil.copy2(original, rec_dir / audio_name)
        if sha256_of(rec_dir / audio_name) != r["sha256"]:
            problems.append(f"checksum differs from the one stored at upload for recording {r['id']} ({r['title']})")
        (rec_dir / (stem + ".md")).write_text(note_text(r, tags.get(r["id"], []), audio_name), encoding="utf-8")
        listing.append((r, tags.get(r["id"], []), audio_name))
    snap.close()

    with open(out_dir / "index.csv", "w", newline="", encoding="utf-8-sig") as fh:      # BOM so Excel reads accents
        w = csv.writer(fh)
        w.writerow(["id", "title", "audio_file", "recorded", "uploaded", "status", "bpm", "key", "mark", "used_in",
                    "tags", "notes", "sha256"])
        for r, tg, name in listing:
            w.writerow([r["id"], r["title"], "recordings/" + name, r["recorded_at"], r["uploaded_at"], r["status"],
                        r["bpm"] or "", key_text(r), r["rating"] or "", r["used_in"] or "", "; ".join(tg), r["notes"],
                        r["sha256"]])

    marks = {"heart": "♥", "check": "✓", "x": "✗"}
    body = []
    for r, tg, name in listing:
        href = "recordings/" + name.replace("%", "%25").replace("#", "%23").replace("?", "%3F").replace(" ", "%20")
        extra = " · ".join(x for x in (f"{r['bpm']} BPM" if r["bpm"] else "", key_text(r), marks.get(r["rating"], ""),
                                       f"used in {r['used_in']}" if r["used_in"] else "") if x)
        body.append(
            f"<tr><td>{html.escape(r['recorded_at'][:10])}</td><td><strong>{html.escape(r['title'])}</strong><br>"
            f"<audio controls preload=\"none\" src=\"{href}\"></audio> <a href=\"{href}\">file</a></td>"
            f"<td>{html.escape(extra)}</td><td>{html.escape(', '.join(tg))}</td>"
            f"<td style=\"white-space:pre-wrap\">{html.escape(r['notes'])}</td></tr>")
    (out_dir / "index.html").write_text(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" "
        "content=\"width=device-width,initial-scale=1\"><title>Riffbox export</title><style>"
        "body{font:16px/1.4 system-ui,sans-serif;margin:1rem auto;max-width:70rem;padding:0 1rem}"
        "td,th{padding:.4rem .6rem;border-bottom:1px solid #8884;text-align:left;vertical-align:top}"
        "audio{max-width:100%}</style></head><body><h1>Riffbox export</h1>"
        f"<p>{len(listing)} recordings. Open a recording's file or press play; nothing here needs a server.</p>"
        "<table><thead><tr><th>Recorded</th><th>Recording</th><th>Details</th><th>Tags</th><th>Notes</th></tr></thead><tbody>"
        + "\n".join(body) + "</tbody></table></body></html>\n", encoding="utf-8")

    (out_dir / "README.txt").write_text(
        "RIFFBOX EXPORT\n==============\n"
        "recordings/  your original audio files with readable names; each has a .md note beside it\n"
        "             (details between the --- lines, your notes below). Plain text: any editor opens it.\n"
        "index.html   open in a web browser to see and play everything (no server needed)\n"
        "index.csv    the same list for a spreadsheet\n"
        "riffbox.db   the complete database, in SQLite format (any SQLite tool opens it)\n"
        "manifest-sha256.txt  checksums; on Linux/macOS/BSD run `sha256sum -c manifest-sha256.txt` (or `shasum -a 256 -c`)\n"
        "The audio files are untouched copies of what was uploaded (m4a, wav, mp3, flac, ...).\n", encoding="utf-8")

    with open(out_dir / "manifest-sha256.txt", "w", encoding="utf-8", newline="\n") as fh:
        for path in sorted(p for p in out_dir.rglob("*") if p.is_file() and p.name != "manifest-sha256.txt"):
            fh.write(f"{sha256_of(path)}  {path.relative_to(out_dir).as_posix()}\n")
    return len(listing), problems


def main(argv=None):
    ap = argparse.ArgumentParser(description="Export a Riffbox data directory to plain, portable files.")
    ap.add_argument("data_dir")
    ap.add_argument("out_dir", help="a new, empty folder")
    ap.add_argument("--include-trash", action="store_true", help="also export recordings in the Trash")
    a = ap.parse_args(argv)
    count, problems = export(a.data_dir, a.out_dir, a.include_trash)
    print(f"exported {count} recordings to {a.out_dir}")
    for p in problems:
        print("WARNING:", p, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())

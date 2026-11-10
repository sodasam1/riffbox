"""Groups: one idea made of one or more recordings. Standard library only, no Flask.

Every recording belongs to exactly one group; most groups have one recording (a "single idea"), and the interface only
talks about groups when there are several parts. The details of an idea (title, tags, tempo, key, notes, marks, status, trash
state) live on the group. The recordings keep their own copies of those columns as a snapshot:

  * while a group has ONE part, every change is written to both (so the snapshot is always current);
  * once a second part joins, the group is the only place that changes, and each part's own copy stays frozen;
  * a part removed from a group becomes a single idea again, starting from its own copy.

A group's dates and sizes are derived from its parts and stored on the group by `refresh()` so that lists and sorts stay
simple: recorded = the earliest part (unless the owner set a date by hand), uploaded = the latest part, length = the longest
part, size = the sum, last played = the most recent play of any part.
"""
import sqlite3

GROUP_FIELDS = ("title", "tempo", "bpm", "key_root", "key_mode", "notes", "status", "rating", "used_in")
KEEP = object()            # "leave the date recorded as it is" (None means "back to the earliest part")
RATING_ORDER = ("heart", "check")


class Conflict(Exception):
    """A request that cannot be carried out because of what the library holds; the message is safe to show."""


# ---- schema and migration ---------------------------------------------------------------------------------------
def migrate(conn):
    """Add what groups need to an existing database, then give every recording a group of its own. Additive: nothing that
    was there is dropped or rewritten. Safe to run again."""
    have = {r[1] for r in conn.execute("PRAGMA table_info(recordings)")}
    if "group_id" not in have:
        conn.execute("ALTER TABLE recordings ADD COLUMN group_id INTEGER REFERENCES idea_groups(id)")
    if "position" not in have:
        conn.execute("ALTER TABLE recordings ADD COLUMN position INTEGER NOT NULL DEFAULT 0")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_recordings_group ON recordings(group_id)")
    backfill(conn)
    conn.commit()


def backfill(conn):
    """One group per recording that has none, copying the recording's details. Where the id is free the group gets the same
    number as its recording (so a library of single ideas has matching numbers)."""
    conn.row_factory, previous = sqlite3.Row, conn.row_factory
    try:
        rows = conn.execute("SELECT * FROM recordings WHERE group_id IS NULL ORDER BY id").fetchall()
        for r in rows:
            taken = conn.execute("SELECT 1 FROM idea_groups WHERE id = ?", (r["id"],)).fetchone()
            override = r["recorded_at"] if r["recorded_at"] != r["uploaded_at"] else None
            cur = conn.execute(
                "INSERT INTO idea_groups (id, title, tempo, bpm, key_root, key_mode, notes, status, rating, used_in, recorded_override,"
                " deleted_at, recorded_at, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (None if taken else r["id"], r["title"], r["tempo"], r["bpm"], r["key_root"], r["key_mode"], r["notes"], r["status"], r["rating"],
                 r["used_in"], override, r["deleted_at"], r["recorded_at"], r["uploaded_at"]))
            gid = cur.lastrowid
            conn.execute("UPDATE recordings SET group_id = ?, position = 0 WHERE id = ?", (gid, r["id"]))
            conn.execute("INSERT OR IGNORE INTO group_tags (group_id, tag) SELECT ?, tag FROM recording_tags WHERE recording_id = ?",
                         (gid, r["id"]))
            refresh(conn, gid)
    finally:
        conn.row_factory = previous


# ---- derived values ----------------------------------------------------------------------------------------------
def refresh(conn, gid):
    """Recompute a group's dates, length, size, last played and part count from its parts."""
    p = conn.execute("SELECT COUNT(*), MIN(recorded_at), MAX(uploaded_at), MAX(duration_s), COALESCE(SUM(size), 0), MAX(last_played_at)"
                     " FROM recordings WHERE group_id = ?", (gid,)).fetchone()
    count, rmin, umax, longest, size, played = p[0], p[1], p[2], p[3], p[4], p[5]
    if not count:
        return
    override = conn.execute("SELECT recorded_override FROM idea_groups WHERE id = ?", (gid,)).fetchone()[0]
    conn.execute("UPDATE idea_groups SET recorded_at = ?, uploaded_at = ?, length_s = ?, size = ?, last_played_at = ?, part_count = ?"
                 " WHERE id = ?", (override or rmin, umax, longest, size, played, count, gid))


def sync_single(conn, gid):
    """While a group has one part, copy its details onto that recording, so the recording's own copy is always current."""
    g = conn.execute("SELECT * FROM idea_groups WHERE id = ?", (gid,)).fetchone()
    if g is None or g["part_count"] != 1:
        return
    conn.execute("UPDATE recordings SET title = ?, tempo = ?, bpm = ?, key_root = ?, key_mode = ?, notes = ?, status = ?, rating = ?, used_in = ?,"
                 " deleted_at = ? WHERE group_id = ?",
                 (g["title"], g["tempo"], g["bpm"], g["key_root"], g["key_mode"], g["notes"], g["status"], g["rating"], g["used_in"],
                  g["deleted_at"], gid))
    conn.execute("DELETE FROM recording_tags WHERE recording_id IN (SELECT id FROM recordings WHERE group_id = ?)", (gid,))
    conn.execute("INSERT OR IGNORE INTO recording_tags (recording_id, tag) SELECT r.id, t.tag FROM recordings r, group_tags t"
                 " WHERE r.group_id = ? AND t.group_id = ?", (gid, gid))


def create_single(conn, recording_id, title, recorded_at, uploaded_at):
    """The group for a freshly uploaded recording (a single idea, in the Inbox)."""
    cur = conn.execute("INSERT INTO idea_groups (title, recorded_at, uploaded_at) VALUES (?,?,?)", (title, recorded_at, uploaded_at))
    gid = cur.lastrowid
    conn.execute("UPDATE recordings SET group_id = ?, position = 0 WHERE id = ?", (gid, recording_id))
    refresh(conn, gid)
    return gid


# ---- reading ----------------------------------------------------------------------------------------------------
def _marks(ids):
    return ",".join("?" * len(ids))


def tags_of(conn, gids):
    """{group id: [tag names]} in the order tags were created (the built-in ones first)."""
    if not gids:
        return {}
    found = {}
    for r in conn.execute(f"SELECT gt.group_id, gt.tag FROM group_tags gt JOIN tags t ON t.name = gt.tag"
                          f" WHERE gt.group_id IN ({_marks(gids)}) ORDER BY t.rowid", list(gids)):
        found.setdefault(r[0], []).append(r[1])
    return found


def parts_of(conn, gids):
    """{group id: [part dicts]} in the order the parts play."""
    if not gids:
        return {}
    found = {}
    for r in conn.execute(f"SELECT id, group_id, title, orig_filename, mime, size, duration_s, recorded_at, uploaded_at, codec, play_status,"
                          f" last_played_at, position FROM recordings WHERE group_id IN ({_marks(gids)}) ORDER BY group_id, position, id",
                          list(gids)):
        found.setdefault(r["group_id"], []).append({k: r[k] for k in r.keys() if k != "group_id"})
    return found


def load(conn, rows):
    """Turn group rows into the dicts the page uses: the group's own details, `parts`, and `duration_s` (the longest part)."""
    gids = [r["id"] for r in rows]
    tags, parts = tags_of(conn, gids), parts_of(conn, gids)
    out = []
    for r in rows:
        d = {k: r[k] for k in ("id", "title", "status", "bpm", "key_root", "key_mode", "notes", "rating", "used_in", "recorded_at",
                               "uploaded_at", "size", "last_played_at", "part_count", "tempo")}
        d["duration_s"] = r["length_s"]
        d["tags"] = tags.get(r["id"], [])
        d["parts"] = parts.get(r["id"], [])
        if "deleted_at" in r.keys() and r["deleted_at"]:
            d["deleted_at"] = r["deleted_at"]
        out.append(d)
    return out


def get(conn, gid, live=True):
    row = conn.execute("SELECT * FROM idea_groups WHERE id = ?" + (" AND deleted_at IS NULL" if live else ""), (gid,)).fetchone()
    return row


def group_of_recording(conn, rec_id, live=True):
    row = conn.execute("SELECT g.* FROM recordings r JOIN idea_groups g ON g.id = r.group_id WHERE r.id = ?"
                       + (" AND g.deleted_at IS NULL" if live else ""), (rec_id,)).fetchone()
    return row


# ---- changing one group --------------------------------------------------------------------------------------
def set_tags(conn, gid, names):
    conn.execute("DELETE FROM group_tags WHERE group_id = ?", (gid,))
    conn.executemany("INSERT INTO group_tags (group_id, tag) VALUES (?, ?)", [(gid, t) for t in names])


def update(conn, gid, cols, tag_list=None, recorded=KEEP, part_labels=None):
    """Change a group. `cols` holds any of GROUP_FIELDS; `tag_list` replaces the tags; `recorded` is a date set by hand (or None to
    go back to the earliest part); `part_labels` is [{id, title}, ...] naming and ordering ALL the parts."""
    if part_labels is not None:
        ids = [r[0] for r in conn.execute("SELECT id FROM recordings WHERE group_id = ?", (gid,))]
        if sorted(p["id"] for p in part_labels) != sorted(ids):
            raise Conflict("the parts list must name every part of the group, once each")
        for i, p in enumerate(part_labels):
            conn.execute("UPDATE recordings SET title = ?, position = ? WHERE id = ?", (p["title"], i, p["id"]))
    if cols:
        conn.execute("UPDATE idea_groups SET " + ", ".join(f"{c} = ?" for c in cols) + " WHERE id = ?", [*cols.values(), gid])
    if tag_list is not None:
        set_tags(conn, gid, tag_list)
    if recorded is not KEEP:
        conn.execute("UPDATE idea_groups SET recorded_override = ? WHERE id = ?", (recorded, gid))
    refresh(conn, gid)
    sole = conn.execute("SELECT 1 FROM idea_groups WHERE id = ? AND part_count = 1", (gid,)).fetchone()
    if sole and recorded is not KEEP:                     # the old rule for a single recording: blank puts the upload date back
        conn.execute("UPDATE recordings SET recorded_at = COALESCE(?, uploaded_at) WHERE group_id = ?", (recorded, gid))
        refresh(conn, gid)
    sync_single(conn, gid)


def trash(conn, gids, now):
    marks = _marks(gids)
    conn.execute(f"UPDATE idea_groups SET deleted_at = ? WHERE deleted_at IS NULL AND id IN ({marks})", [now, *gids])
    conn.execute(f"UPDATE recordings SET deleted_at = ? WHERE deleted_at IS NULL AND group_id IN ({marks})", [now, *gids])


def restore(conn, gid):
    """Bring a trashed group back with all its parts, unless the same audio has been uploaded again since."""
    twin = conn.execute("SELECT p.title FROM recordings r JOIN recordings p ON p.sha256 = r.sha256 AND p.deleted_at IS NULL"
                        " AND p.group_id != r.group_id WHERE r.group_id = ?", (gid,)).fetchone()
    if twin:
        raise Conflict(f"The same audio is already in your lists as “{twin[0]}”.")
    conn.execute("UPDATE idea_groups SET deleted_at = NULL WHERE id = ?", (gid,))
    conn.execute("UPDATE recordings SET deleted_at = NULL WHERE group_id = ?", (gid,))
    sync_single(conn, gid)


# ---- making and breaking groups ---------------------------------------------------------------------------------
def suggest(conn, gids):
    """What a group made from these ideas would start with: every field, plus the values that disagree (tempo, key)."""
    rows = [get(conn, g) for g in gids]
    if any(r is None for r in rows) or len(rows) < 1:
        raise Conflict("some of these ideas no longer exist; reload the page")
    rows.sort(key=lambda r: (r["recorded_at"], r["id"]))
    tags = tags_of(conn, [r["id"] for r in rows])
    union = {t for g in rows for t in tags.get(g["id"], [])}
    order = [r[0] for r in conn.execute("SELECT name FROM tags ORDER BY rowid")]
    notes = "\n\n".join(f"{r['title']}: {r['notes']}" if len(rows) > 1 else r["notes"] for r in rows if r["notes"])
    ratings = {r["rating"] for r in rows}
    rating = next((m for m in RATING_ORDER if m in ratings), "x" if ratings == {"x"} else None)
    used = next((r["used_in"] for r in rows if r["used_in"] and r["rating"] == "check"), None) if rating == "check" else None

    def conflicts(field, label):
        seen = {}
        for r in rows:
            if r[field] is not None:
                seen.setdefault(r[field], []).append(r["title"])
        return [{"value": v, "from": names} for v, names in seen.items()] if len(seen) > 1 else []
    keys = {}
    for r in rows:
        if r["key_root"] or r["key_mode"]:
            keys.setdefault((r["key_root"], r["key_mode"]), []).append(r["title"])
    bpms = {r["bpm"] for r in rows if r["bpm"] is not None}
    return {
        "title": rows[0]["title"], "tags": [t for t in order if t in union], "notes": notes, "rating": rating, "used_in": used,
        "bpm": next(iter(bpms)) if len(bpms) == 1 else None,
        "key_root": next(iter(keys))[0] if len(keys) == 1 else None, "key_mode": next(iter(keys))[1] if len(keys) == 1 else None,
        "status": "inbox" if any(r["status"] == "inbox" for r in rows) else "tagged",
        "conflicts": {"bpm": conflicts("bpm", "bpm"), "key": [{"key_root": k[0], "key_mode": k[1], "from": v} for k, v in keys.items()] if len(keys) > 1 else []},
    }


def _move_parts(conn, source_gids, target, start):
    """Move every part of the source groups into `target`, earliest group first, numbering them from `start`."""
    order = conn.execute(f"SELECT r.id FROM recordings r JOIN idea_groups g ON g.id = r.group_id WHERE r.group_id IN ({_marks(source_gids)})"
                         f" ORDER BY g.recorded_at, g.id, r.position, r.id", list(source_gids)).fetchall()
    for i, (rid,) in enumerate(order, start):
        conn.execute("UPDATE recordings SET group_id = ?, position = ? WHERE id = ?", (target, i, rid))
    conn.execute(f"DELETE FROM group_tags WHERE group_id IN ({_marks(source_gids)})", list(source_gids))
    conn.execute(f"DELETE FROM idea_groups WHERE id IN ({_marks(source_gids)})", list(source_gids))


def combine(conn, gids, fields, tag_list):
    """Make ONE new group out of the given ideas (singles and/or groups). `fields` holds the details of the new group."""
    gids = list(dict.fromkeys(gids))
    if len(gids) < 2:
        raise Conflict("choose at least two recordings to group")
    if any(get(conn, g) is None for g in gids):
        raise Conflict("some of these ideas no longer exist; reload the page")
    row = {f: fields.get(f) for f in GROUP_FIELDS}
    cur = conn.execute("INSERT INTO idea_groups (title, bpm, key_root, key_mode, notes, status, rating, used_in, recorded_at, uploaded_at)"
                       " VALUES (?,?,?,?,?,?,?,?, '', '')",
                       (row["title"], row["bpm"], row["key_root"], row["key_mode"], row["notes"] or "", row["status"] or "inbox",
                        row["rating"], row["used_in"]))
    new = cur.lastrowid
    set_tags(conn, new, tag_list)
    _move_parts(conn, gids, new, 0)
    refresh(conn, new)
    return new


def add_to(conn, target, gids):
    """Move the given ideas into an existing group (it keeps its own details); they become its last parts."""
    if get(conn, target) is None:
        raise Conflict("that group no longer exists; reload the page")
    gids = [g for g in dict.fromkeys(gids) if g != target]
    if not gids or any(get(conn, g) is None for g in gids):
        raise Conflict("some of these ideas no longer exist; reload the page")
    start = conn.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM recordings WHERE group_id = ?", (target,)).fetchone()[0]
    _move_parts(conn, gids, target, start)
    refresh(conn, target)
    return target


def _split_out(conn, rec_id, status, deleted_at=None):
    """Give a recording a group of its own again, starting from the details it kept when it joined (its own copy)."""
    r = conn.execute("SELECT * FROM recordings WHERE id = ?", (rec_id,)).fetchone()
    override = r["recorded_at"] if r["recorded_at"] != r["uploaded_at"] else None
    cur = conn.execute("INSERT INTO idea_groups (title, tempo, bpm, key_root, key_mode, notes, status, rating, used_in, recorded_override, deleted_at,"
                       " recorded_at, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (r["title"], r["tempo"], r["bpm"], r["key_root"], r["key_mode"], r["notes"], status, r["rating"], r["used_in"], override,
                        deleted_at, r["recorded_at"], r["uploaded_at"]))
    new = cur.lastrowid
    conn.execute("UPDATE recordings SET group_id = ?, position = 0 WHERE id = ?", (new, rec_id))
    conn.execute("INSERT OR IGNORE INTO group_tags (group_id, tag) SELECT ?, tag FROM recording_tags WHERE recording_id = ?", (new, rec_id))
    refresh(conn, new)
    return new


def _renumber(conn, gid):
    for i, (rid,) in enumerate(conn.execute("SELECT id FROM recordings WHERE group_id = ? ORDER BY position, id", (gid,)).fetchall()):
        conn.execute("UPDATE recordings SET position = ? WHERE id = ?", (i, rid))
    refresh(conn, gid)
    sync_single(conn, gid)


def remove_part(conn, gid, rec_id):
    """Take one part out of a group: it becomes its own single idea (in the same place: Inbox or Library)."""
    g = get(conn, gid)
    if g is None:
        raise Conflict("that group no longer exists; reload the page")
    if not conn.execute("SELECT 1 FROM recordings WHERE id = ? AND group_id = ?", (rec_id, gid)).fetchone():
        raise Conflict("that recording is not in this group")
    if g["part_count"] < 2:
        raise Conflict("a group needs at least two parts to take one out")
    new = _split_out(conn, rec_id, g["status"])
    _renumber(conn, gid)
    return new


def ungroup(conn, gid):
    """Break a group up: every part becomes its own single idea again. Returns the new group ids."""
    g = get(conn, gid)
    if g is None:
        raise Conflict("that group no longer exists; reload the page")
    parts = [r[0] for r in conn.execute("SELECT id FROM recordings WHERE group_id = ? ORDER BY position, id", (gid,))]
    new = [_split_out(conn, rid, g["status"]) for rid in parts]
    conn.execute("DELETE FROM group_tags WHERE group_id = ?", (gid,))
    conn.execute("DELETE FROM idea_groups WHERE id = ?", (gid,))
    return new

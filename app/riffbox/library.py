"""Phase 5: finding recordings. Turns the list request's query string into one SQL query.

Pure (no Flask): the request arguments come in as a plain mapping, so every rule is unit-tested
against a real database. Nothing from the request is ever pasted into the SQL text: values go in as
parameters, and the sort column comes from a fixed table.
"""
from .intake import Invalid, KEY_MODES, KEY_ROOTS, STATUSES, TEMPOS, normalize_tag

SORTS = {
    "recorded": "r.recorded_at",
    "uploaded": "r.uploaded_at",
    "title": "LOWER(r.title)",
    "bpm": "r.bpm",
}
DEFAULT_ORDER = {"recorded": "desc", "uploaded": "desc", "title": "asc", "bpm": "desc"}
MAX_QUERY_CHARS = 200
MAX_TERMS = 8
MAX_TAG_FILTERS = 30


def _csv(raw):
    return [p.strip() for p in raw.split(",") if p.strip()] if raw else []


def parse_filters(args):
    """`args` is request.args (or any object with .get). Returns a dict; raises Invalid."""
    f = {}

    status = args.get("status")
    if status is not None and status not in STATUSES:
        raise Invalid("status must be inbox or tagged")
    f["status"] = status

    q = (args.get("q") or "").strip()
    if len(q) > MAX_QUERY_CHARS:
        raise Invalid(f"search is longer than {MAX_QUERY_CHARS} characters")
    f["terms"] = q.lower().split()[:MAX_TERMS]

    tags = []
    for name in _csv(args.get("tags")):
        norm = normalize_tag(name)
        if norm not in tags:
            tags.append(norm)
    if len(tags) > MAX_TAG_FILTERS:
        raise Invalid(f"at most {MAX_TAG_FILTERS} tags can be combined")
    f["tags"] = tags

    match = args.get("match", "all")
    if match not in ("all", "any"):
        raise Invalid("match must be all or any")
    f["match"] = match

    tempos = _csv(args.get("tempo"))
    for t in tempos:
        if t not in TEMPOS:
            raise Invalid(f"tempo must be one of {', '.join(TEMPOS)}")
    f["tempos"] = tempos

    for field, allowed in (("key_root", KEY_ROOTS), ("key_mode", KEY_MODES)):
        value = args.get(field) or None
        if value is not None and value not in allowed:
            raise Invalid(f"{field} must be one of {', '.join(allowed)}")
        f[field] = value

    sort = args.get("sort", "recorded")
    if sort not in SORTS:
        raise Invalid(f"sort must be one of {', '.join(SORTS)}")
    order = args.get("order") or DEFAULT_ORDER[sort]
    if order not in ("asc", "desc"):
        raise Invalid("order must be asc or desc")
    f["sort"], f["order"] = sort, order
    return f


def _like(term):
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def build_query(f):
    """Returns (sql, params) for the recordings that match the parsed filters `f`."""
    where, params = ["r.deleted_at IS NULL"], []

    if f["status"]:
        where.append("r.status = ?")
        params.append(f["status"])

    for term in f["terms"]:          # every word must appear in the title, the notes or a tag name
        where.append("(LOWER(r.title) LIKE ? ESCAPE '\\' OR LOWER(r.notes) LIKE ? ESCAPE '\\'"
                     " OR EXISTS (SELECT 1 FROM recording_tags t WHERE t.recording_id = r.id"
                     " AND t.tag LIKE ? ESCAPE '\\'))")
        params += [_like(term)] * 3

    if f["tags"]:
        marks = ",".join("?" * len(f["tags"]))
        if f["match"] == "all":
            where.append(f"(SELECT COUNT(DISTINCT t.tag) FROM recording_tags t WHERE t.recording_id = r.id"
                         f" AND t.tag IN ({marks})) = ?")
            params += [*f["tags"], len(f["tags"])]
        else:
            where.append(f"EXISTS (SELECT 1 FROM recording_tags t WHERE t.recording_id = r.id"
                         f" AND t.tag IN ({marks}))")
            params += f["tags"]

    if f["tempos"]:
        where.append(f"r.tempo IN ({','.join('?' * len(f['tempos']))})")
        params += f["tempos"]
    for field in ("key_root", "key_mode"):
        if f[field]:
            where.append(f"r.{field} = ?")
            params.append(f[field])

    direction = "DESC" if f["order"] == "desc" else "ASC"
    column = SORTS[f["sort"]]
    order = f"{column} {direction}"
    if f["sort"] == "bpm":
        order = f"r.bpm IS NULL, {order}"        # recordings without a BPM always go last
    sql = f"SELECT r.* FROM recordings r WHERE {' AND '.join(where)} ORDER BY {order}, r.id DESC"
    return sql, params

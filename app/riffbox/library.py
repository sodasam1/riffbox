"""Phase 5: finding recordings. Turns the list request's query string into one SQL query.

Pure (no Flask): the request arguments come in as a plain mapping, so every rule is unit-tested
against a real database. Nothing from the request is ever pasted into the SQL text: values go in as
parameters, and the sort column comes from a fixed table.
"""
from .intake import BPM_RANGE, Invalid, KEY_MODES, KEY_ROOTS, RATINGS, STATUSES, TEMPOS, normalize_tag

SORTS = {
    "recorded": "r.recorded_at",
    "uploaded": "r.uploaded_at",
    "title": "LOWER(r.title)",
    "bpm": "r.bpm",
    "length": "r.duration_s",
    "played": "r.last_played_at",
}
DEFAULT_ORDER = {"recorded": "desc", "uploaded": "desc", "title": "asc", "bpm": "desc",
                 "length": "desc", "played": "desc"}
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

    marks = _csv(args.get("rating"))                 # heart, check, x, and "none" for unmarked
    for m in marks:
        if m not in (*RATINGS, "none"):
            raise Invalid("rating must be a comma-separated list of heart, check, x, none")
    f["ratings"] = list(dict.fromkeys(marks))

    for field in ("bpm_min", "bpm_max"):          # a BPM range; recordings with no BPM never match it
        raw = args.get(field)
        if raw is None or str(raw).strip() == "":
            f[field] = None
            continue
        try:
            value = int(str(raw).strip())
        except ValueError:
            raise Invalid(f"{field} must be a whole number") from None
        if not BPM_RANGE[0] <= value <= BPM_RANGE[1]:
            raise Invalid(f"{field} must be between {BPM_RANGE[0]} and {BPM_RANGE[1]}")
        f[field] = value
    if f["bpm_min"] is not None and f["bpm_max"] is not None and f["bpm_min"] > f["bpm_max"]:
        raise Invalid("bpm_min cannot be higher than bpm_max")

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
    if f["ratings"]:
        real = [m for m in f["ratings"] if m != "none"]
        clauses = []
        if real:
            clauses.append(f"r.rating IN ({','.join('?' * len(real))})")
            params += real
        if "none" in f["ratings"]:
            clauses.append("r.rating IS NULL")
        where.append("(" + " OR ".join(clauses) + ")")
    if f["bpm_min"] is not None:
        where.append("r.bpm >= ?")                # a missing BPM (NULL) fails the comparison, so it is excluded
        params.append(f["bpm_min"])
    if f["bpm_max"] is not None:
        where.append("r.bpm <= ?")
        params.append(f["bpm_max"])
    for field in ("key_root", "key_mode"):
        if f[field]:
            where.append(f"r.{field} = ?")
            params.append(f[field])

    direction = "DESC" if f["order"] == "desc" else "ASC"
    column = SORTS[f["sort"]]
    order = f"{column} {direction}"
    if f["sort"] in ("bpm", "length"):
        order = f"{column} IS NULL, {order}"     # recordings with no BPM / unknown length always go last
    # "played" needs no special case: never-played (empty) sorts first oldest-first and last newest-first,
    # which is what "longest ago first" and "most recent first" mean.
    sql = f"SELECT r.* FROM recordings r WHERE {' AND '.join(where)} ORDER BY {order}, r.id DESC"
    return sql, params

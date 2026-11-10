"""Phase 5: finding recordings. Turns the list request's query string into one SQL query.

Pure (no Flask): the request arguments come in as a plain mapping, so every rule is unit-tested
against a real database. Nothing from the request is ever pasted into the SQL text: values go in as
parameters, and the sort column comes from a fixed table.
"""
from .intake import (
    BPM_RANGE,
    KEY_MODES,
    KEY_ROOTS,
    RATINGS,
    STATUSES,
    TEMPOS,
    Invalid,
    normalize_tag,
)

SORTS = {
    "recorded": "g.recorded_at",
    "uploaded": "g.uploaded_at",
    "title": "ulower(g.title)",
    "bpm": "g.bpm",
    "length": "g.length_s",
    "played": "g.last_played_at",
}
DEFAULT_SORT = "uploaded"          # newest upload first, unless the page asks for something else
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

    sort = args.get("sort", DEFAULT_SORT)
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
    """Returns (sql, params) for the ideas (groups) that match the parsed filters `f`. Every detail searched or sorted on is
    the group's own; text search also looks at the parts' titles (any part)."""
    where, params = ["g.deleted_at IS NULL"], []

    if f["status"]:
        where.append("g.status = ?")
        params.append(f["status"])

    for term in f["terms"]:          # every word must appear in the title, the notes, a tag name or a part's title
        where.append("(ulower(g.title) LIKE ? ESCAPE '\\' OR ulower(g.notes) LIKE ? ESCAPE '\\'"
                     " OR EXISTS (SELECT 1 FROM group_tags t WHERE t.group_id = g.id AND t.tag LIKE ? ESCAPE '\\')"
                     " OR EXISTS (SELECT 1 FROM recordings p WHERE p.group_id = g.id AND ulower(p.title) LIKE ? ESCAPE '\\'))")
        params += [_like(term)] * 4

    if f["tags"]:
        marks = ",".join("?" * len(f["tags"]))
        if f["match"] == "all":
            where.append(f"(SELECT COUNT(DISTINCT t.tag) FROM group_tags t WHERE t.group_id = g.id"
                         f" AND t.tag IN ({marks})) = ?")
            params += [*f["tags"], len(f["tags"])]
        else:
            where.append(f"EXISTS (SELECT 1 FROM group_tags t WHERE t.group_id = g.id"
                         f" AND t.tag IN ({marks}))")
            params += f["tags"]

    if f["tempos"]:
        where.append(f"g.tempo IN ({','.join('?' * len(f['tempos']))})")
        params += f["tempos"]
    if f["ratings"]:
        real = [m for m in f["ratings"] if m != "none"]
        clauses = []
        if real:
            clauses.append(f"g.rating IN ({','.join('?' * len(real))})")
            params += real
        if "none" in f["ratings"]:
            clauses.append("g.rating IS NULL")
        where.append("(" + " OR ".join(clauses) + ")")
    if f["bpm_min"] is not None:
        where.append("g.bpm >= ?")                # a missing BPM (NULL) fails the comparison, so it is excluded
        params.append(f["bpm_min"])
    if f["bpm_max"] is not None:
        where.append("g.bpm <= ?")
        params.append(f["bpm_max"])
    for field in ("key_root", "key_mode"):
        if f[field]:
            where.append(f"g.{field} = ?")
            params.append(f[field])

    direction = "DESC" if f["order"] == "desc" else "ASC"
    column = SORTS[f["sort"]]
    order = f"{column} {direction}"
    if f["sort"] in ("bpm", "length"):
        order = f"{column} IS NULL, {order}"     # ideas with no BPM / unknown length always go last
    # "played" needs no special case: never-played (empty) sorts first oldest-first and last newest-first,
    # which is what "longest ago first" and "most recent first" mean.
    sql = f"SELECT g.* FROM idea_groups g WHERE {' AND '.join(where)} ORDER BY {order}, g.id {direction}"
    return sql, params

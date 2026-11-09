"""Rules for the intake form (phase 4): what a recording's details may contain.

Everything here is pure (no Flask, no database), so it is unit-tested directly. All fields are
optional: an empty or untouched form is valid, and null/None clears a field.
"""
import datetime as dt
import re

TEMPOS = ("slow", "medium", "fast")
KEY_ROOTS = ("C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")
KEY_MODES = ("major", "minor")
STATUSES = ("inbox", "tagged")
BPM_RANGE = (20, 400)
MAX_TITLE = 200
MAX_NOTES = 5000
MAX_TAGS_PER_RECORDING = 30
MAX_TAGS_TOTAL = 100
RATINGS = ("heart", "check", "x")           # interesting / used in a song / no longer interesting
MAX_USED_IN = 200
PATCHABLE = {"title", "tempo", "bpm", "key_root", "key_mode", "notes", "tags", "status", "recorded_at",
             "rating", "used_in"}
EARLIEST_DATE = dt.date(1950, 1, 1)

_TAG_RE = re.compile(r"[\w][\w &'/+.\-]{0,29}")


class Invalid(ValueError):
    """A request value that breaks the rules; the message is safe to show the user."""


def normalize_tag(raw):
    """'  Rhythmic   IDEA ' -> 'rhythmic idea'. Raises Invalid if it is not a usable tag name."""
    if not isinstance(raw, str):
        raise Invalid("tag names must be text")
    name = " ".join(raw.split()).lower()
    if not name:
        raise Invalid("tag name is empty")
    if not _TAG_RE.fullmatch(name):
        raise Invalid("tag names are 1 to 30 characters: letters, numbers, spaces and & ' / + . -")
    return name


def parse_instant(raw):
    """A timestamp like '2026-03-01T12:00:00Z' -> the same instant normalised to UTC text.
    The page sends a chosen calendar day as local noon on that day. Raises Invalid."""
    if not isinstance(raw, str) or len(raw) > 40:
        raise Invalid("recorded_at must be a timestamp like 2026-03-01T12:00:00Z (or null)")
    try:
        parsed = dt.datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        raise Invalid("recorded_at must be a timestamp like 2026-03-01T12:00:00Z (or null)") from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    try:
        parsed = parsed.astimezone(dt.timezone.utc)
    except OverflowError:                 # e.g. year 1 with a positive offset
        raise Invalid("recorded_at must be a timestamp like 2026-03-01T12:00:00Z (or null)") from None
    if parsed.date() < EARLIEST_DATE:
        raise Invalid("the date recorded cannot be before 1950")
    if parsed > dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1):      # a day of slack for time zones
        raise Invalid("the date recorded cannot be in the future")
    return parsed.strftime("%Y-%m-%dT%H:%M:%SZ")


def _one_of(field, value, allowed):
    if value is not None and value not in allowed:
        raise Invalid(f"{field} must be one of {', '.join(allowed)} (or null)")
    return value


def validate_patch(body, known_tags, default_title, uploaded_at=None):
    """Check an update request. Returns (column_values, tag_list_or_None); raises Invalid.

    body          the parsed JSON object
    known_tags    set of tag names that exist
    default_title what a blank title falls back to
    uploaded_at   what a cleared "date recorded" falls back to: the date it was uploaded
    """
    unknown = set(body) - PATCHABLE
    if unknown:
        raise Invalid("cannot change: " + ", ".join(sorted(unknown)))

    cols = {}
    tags = None

    if "title" in body:
        title = body["title"]
        if not isinstance(title, str):
            raise Invalid("title must be text")
        title = title.strip()
        if len(title) > MAX_TITLE:
            raise Invalid(f"title is longer than {MAX_TITLE} characters")
        cols["title"] = title or default_title

    if "tempo" in body:
        cols["tempo"] = _one_of("tempo", body["tempo"], TEMPOS)

    if "rating" in body:
        cols["rating"] = _one_of("rating", body["rating"], RATINGS)
    if "used_in" in body:
        used = body["used_in"]
        if used is not None and not isinstance(used, str):
            raise Invalid("used_in must be text (or null)")
        used = (used or "").strip()
        if len(used) > MAX_USED_IN:
            raise Invalid(f"used_in is longer than {MAX_USED_IN} characters")
        cols["used_in"] = used or None

    if "recorded_at" in body:
        raw = body["recorded_at"]
        if raw is None or raw == "":                # blank: the date recorded is the date uploaded
            if uploaded_at is None:
                raise Invalid("cannot reset the date recorded without the upload date")
            cols["recorded_at"] = uploaded_at
        else:
            cols["recorded_at"] = parse_instant(raw)

    if "bpm" in body:
        bpm = body["bpm"]
        if bpm is not None:
            if isinstance(bpm, bool) or not isinstance(bpm, int):
                raise Invalid("bpm must be a whole number (or null)")
            if not BPM_RANGE[0] <= bpm <= BPM_RANGE[1]:
                raise Invalid(f"bpm must be between {BPM_RANGE[0]} and {BPM_RANGE[1]}")
        cols["bpm"] = bpm

    if "key_root" in body:
        cols["key_root"] = _one_of("key_root", body["key_root"], KEY_ROOTS)
    if "key_mode" in body:
        cols["key_mode"] = _one_of("key_mode", body["key_mode"], KEY_MODES)

    if "notes" in body:
        notes = body["notes"]
        if not isinstance(notes, str):
            raise Invalid("notes must be text")
        notes = notes.strip()
        if len(notes) > MAX_NOTES:
            raise Invalid(f"notes are longer than {MAX_NOTES} characters")
        cols["notes"] = notes

    if "status" in body:
        if body["status"] not in STATUSES:
            raise Invalid("status must be inbox or tagged")
        cols["status"] = body["status"]

    if "tags" in body:
        raw = body["tags"]
        if not isinstance(raw, list):
            raise Invalid("tags must be a list")
        chosen = []
        for item in raw:
            name = normalize_tag(item)
            if name not in known_tags:
                raise Invalid(f"unknown tag '{name}' (create it first)")
            if name not in chosen:
                chosen.append(name)
        if len(chosen) > MAX_TAGS_PER_RECORDING:
            raise Invalid(f"at most {MAX_TAGS_PER_RECORDING} tags per recording")
        tags = chosen

    return cols, tags


BULK_CHANGES = {"add_tags", "remove_tags", "rating", "status", "trash"}
MAX_BULK = 500


def validate_bulk(body, known_tags):
    """Check a bulk-change request: {"ids": [...], "changes": {...}}. Returns (ids, changes); raises Invalid.

    changes may hold: add_tags (names that exist), remove_tags, rating (heart/check/x/null), status (inbox/tagged),
    or trash: true (which cannot be combined with the others)."""
    ids = body.get("ids")
    if (not isinstance(ids, list) or not ids or len(ids) > MAX_BULK
            or any(isinstance(i, bool) or not isinstance(i, int) for i in ids)):
        raise Invalid(f"ids must be a list of 1 to {MAX_BULK} recording numbers")
    ids = list(dict.fromkeys(ids))
    raw = body.get("changes")
    if not isinstance(raw, dict) or not raw:
        raise Invalid("say what to change")
    unknown = set(raw) - BULK_CHANGES
    if unknown:
        raise Invalid("cannot change: " + ", ".join(sorted(unknown)))
    if "trash" in raw and (raw["trash"] is not True or len(raw) > 1):
        raise Invalid("trash must be true and cannot be combined with other changes")
    changes = {}
    for key in ("add_tags", "remove_tags"):
        if key in raw:
            names = raw[key]
            if not isinstance(names, list) or not names:
                raise Invalid(f"{key} must be a list of tag names")
            changes[key] = list(dict.fromkeys(normalize_tag(n) for n in names))
    for name in changes.get("add_tags", ()):
        if name not in known_tags:
            raise Invalid(f"unknown tag '{name}' (create it first)")
    if "rating" in raw:
        changes["rating"] = _one_of("rating", raw["rating"], RATINGS)
    if "status" in raw:
        if raw["status"] not in STATUSES:
            raise Invalid("status must be inbox or tagged")
        changes["status"] = raw["status"]
    if raw.get("trash") is True:
        changes["trash"] = True
    return ids, changes

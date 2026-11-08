"""Rules for the intake form (phase 4): what a recording's details may contain.

Everything here is pure (no Flask, no database), so it is unit-tested directly. All fields are
optional: an empty or untouched form is valid, and null/None clears a field.
"""
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
PATCHABLE = {"title", "tempo", "bpm", "key_root", "key_mode", "notes", "tags", "status"}

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


def _one_of(field, value, allowed):
    if value is not None and value not in allowed:
        raise Invalid(f"{field} must be one of {', '.join(allowed)} (or null)")
    return value


def validate_patch(body, known_tags, default_title):
    """Check an update request. Returns (column_values, tag_list_or_None); raises Invalid.

    body          the parsed JSON object
    known_tags    set of tag names that exist
    default_title what a blank title falls back to
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

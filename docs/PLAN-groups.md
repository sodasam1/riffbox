# Planned: groups (one idea made of several recordings)

Written 10 Nov 2026. **Nothing here is built yet.** This records the owner's requirements as stated, the design they imply,
the points where two requirements interact or are ambiguous, and a staged implementation plan. It supersedes the earlier
"Songs view" idea in `docs/PLAN.md`. Build status stays in `PHASES.md`.

## 1. What the owner wants (as stated)

**The idea.** A *group* is for recordings that do not make sense on their own and took several audio files to capture, but
that are still one idea (for example a keys riff, a drums riff and a vocal riff recorded as three voice memos). The owner calls
it a "group", not a "song". The way the owner thinks about it drives the design.

**Where the details live.** For a multi-recording idea, everything that describes the idea (tags, tempo, key, notes, marks)
belongs to the **group**, not to the individual recordings. Single-recording ideas are the vast majority of the library, so
the model must treat them consistently (see the open question about whether every entry gets a group, answered in 3.1).

**Dates.** A group shows the **earliest recorded** date and the **latest upload** date of its parts. The individual
recordings keep their own data "just in case".

**Tempo and key.** Assigned at the group level, so a group can never have conflicting values. The owner is unsure how this
changes the upload workflow (answered in 3.5).

**Looks.** It complements the expandable song row (option 1 of the earlier visual proposal): a multi-recording idea must look
**nearly identical to a single-recording idea when collapsed**, and expands to show its parts.

**Select mode.** Selecting a group row selects all of its parts. Grouping is made from Select mode with a **Group** action,
and must also be possible **in the Inbox**, because the owner typically uploads all parts together and wants to make the
association while they are still in the Inbox.

**Filters.** The owner suggested a control that toggles between "match *any* part of a group" and "match *all* parts of a
group" (but see 4.4: with the details at group level this needs rethinking).

**Keyboard and playback.** Moving down with the arrow keys onto a group expands it automatically and starts playing its top
recording (when moving up onto a group: its bottom recording). Arrow keys then move through the parts as if they were
separate lines, and the group collapses again when you move off it, unless the user had opened it by hand, in which case it
stays as the user left it. (The owner wrote "stay closed"; this is taken to be a slip for "stay open", see section 7.)

**Resurface.** For any recording that belongs to a group, Resurface always brings up **the entire group**: the pieces make no
sense alone, so retrieving one is pointless.

**Performance.** For now: get the feature working, keeping it as efficient as possible. The separate speed plan
(`docs/PLAN-performance-ux-sustainability.md`) still applies afterwards.

## 2. Terms

- **Idea / group:** the thing a row in the Inbox or Library represents. A group has one or more **parts**.
- **Part:** one recording (one audio file) inside a group.
- **Single idea:** a group with exactly one part. In the interface it is never called a group; it looks and behaves as today.
- UI words: "Group" (the action and the noun), "part" for a recording inside a group.

## 3. Design

### 3.1 Does every entry get a group? Yes, internally. Recommended model.

Two ways to do it:

| | A. Every recording belongs to a group (singles are groups of one) | B. Groups exist only for multi-part ideas |
|---|---|---|
| Where details live | always on the group: one code path | on the recording for singles, on the group for multi-part: two paths |
| Lists, filters, sorts, bulk, Resurface, export | one query, one row type | each needs a union of two kinds of row |
| Cost | a one-time migration of every recording; the API grows a group layer | smaller migration, but permanent branching in every feature |
| Risk | the migration (mitigated below) | subtle bugs where the two paths disagree |

**Recommendation: A.** The owner's own reasoning points to it ("for consistency, every entry has one"), and it keeps the code
smaller over time. The interface hides it: a group of one has no caret, no badge, no "group" wording.

Internal naming: the table is `idea_groups` (`groups` is an SQL keyword and would need quoting everywhere).

### 3.2 Tables and columns

New:
- `idea_groups`: `id`, `title`, `bpm`, `key_root`, `key_mode`, `notes`, `status` (`inbox` | `tagged`), `rating`, `used_in`,
  `deleted_at`, plus **denormalised** `recorded_at` (earliest of the parts, or a manual override) and `uploaded_at` (latest
  of the parts), `length_s`, `size`, `last_played_at`, `part_count`. These are recomputed by one function
  (`refresh_group`) whenever membership or a part changes, so lists and sorts stay simple and indexable.
- `group_tags(group_id, tag)`: the group's tags (the existing `tags` table is reused).

Changed:
- `recordings` gains `group_id` (NOT NULL, foreign key) and `position` (order of the part inside its group).

Kept unchanged on `recordings` (this is the "retain their data" requirement): `title` (which becomes the **part label**, still
editable), `bpm`, `key_root`, `key_mode`, `notes`, `rating`, `used_in`, `recorded_at`, `uploaded_at`, `status`, and the old
`recording_tags`. After the migration the group is authoritative for all of those; the recording's own copy is a **snapshot**.
The snapshot is refreshed from the group at the moment a single idea joins a multi-part group, so what is retained is the
latest state before grouping.

Effective values for a group:
- **Recorded date:** the group's manual override if the owner set one, otherwise the earliest part. **Uploaded date:** the latest part.
- **Length:** the longest part (the parts are layers of one idea, so a sum would overstate it). The tooltip lists each part.
- **Size:** the sum of the parts. **Last played:** the most recent play of any part.
- **Marks and "used in":** on the group.

### 3.3 API shape

- `GET /api/groups` replaces the list for the Inbox and Library: one item per group, each with `parts` (id, part label,
  length, size, recorded, uploaded, play status). Same filters and sorts as today, applied to group-level fields. Counts
  ("Library (8)") count ideas. `GET /api/trash` and `GET /api/resurface` become group-shaped too.
- `PATCH /api/groups/<id>` edits the group (title, tags, bpm, key, notes, status, rating, used_in, recorded override).
- `POST /api/groups` makes a group from recording or group ids (see 3.6); `POST /api/groups/<id>/parts` adds parts;
  `DELETE /api/groups/<id>/parts/<rec_id>` removes one (it becomes its own single idea, restored from its snapshot);
  `POST /api/groups/<id>/ungroup`; `PATCH` of a part changes only its label.
- `POST /api/bulk` works on group ids. Trash and restore work on groups (a trashed group takes all of its parts; restore
  brings them all back).
- Compatibility: `PATCH /api/recordings/<id>` stays and edits that recording's group (for a single idea this is what it is
  today). Audio, play, analysis, played and upload endpoints stay recording-level and unchanged. This keeps the phone
  Shortcut and most of the existing tests working during the transition.

### 3.4 What a row looks like

- **Collapsed group:** the same columns as a single idea: group title, group tags, group tempo and key, length, recorded
  (earliest), uploaded (latest), the same actions. Only two small additions: a **▸ caret** in the lead cell next to the play
  button and a quiet **"3"** parts badge by the title. Compact mode follows the same rule.
- **Expanded:** the parts appear indented beneath as plain rows (play button, part label, length, size, the part's own
  recorded date in muted text, Download, "Remove from group"). Parts have no tags, tempo, key, notes or marks of their own.
- **Group Edit form:** the normal form (title, tags, marks, BPM, key, date recorded, notes) plus a **Parts** list with
  rename, reorder, remove and "Add recordings…".
- **Download:** a group's Download offers each part, with "all parts (zip)" as a later addition.
- Stable-layout rules (`ui-stable-tabs`) apply unchanged; the minimal theme gets the caret, badge and part-row styling.

### 3.5 Tempo, key and the upload workflow

- Uploading never creates conflicts: every upload (browser or Shortcut) creates one recording in a **new single idea**, with
  the tempo and key typed (if any) on that idea.
- **Grouping resolves differences on purpose.** When several ideas are grouped, a dialog asks for the group's tempo and key,
  prefilled if all parts agree, otherwise showing the values found ("120 from *keys*, 96 from *drums*") to choose from or
  overwrite. A group can therefore never hold two values. The dialog also prefills the title (the earliest part's), the tags
  (the union, editable), the notes (the parts' notes joined, editable) and the mark (the strongest one).
- **Uploading several files together** (the owner's usual case): when more than one file is chosen or dropped, the upload bar
  offers "These are parts of one idea". The files upload as usual and are then grouped in one step, with a title taken from the
  first file and the rest editable later in the Inbox.
- The phone Shortcut is unchanged: each memo uploads alone, and parts are grouped later in the Inbox. A later option: suggest
  grouping when recordings were made within, say, 20 minutes of each other (still a manual confirmation, no AI).

### 3.6 Making and changing groups

- **Select mode in the Inbox as well as the Library** (today it is Library-only): the Select slot in the tab row becomes
  active on both tabs. The bulk bar gains **Group…** (two or more selected), **Add to group…** (choose an existing group) and
  keeps the existing tag, mark, Inbox and Trash actions, which now act on whole groups.
- Grouping groups merges them: all parts of all selected ideas end up in one new group.
- A group made from Inbox parts stays in the Inbox; if the selection mixes Inbox and Library the dialog asks where it goes
  (default: the Inbox, so nothing untagged slips into the Library).
- **Ungroup** and **Remove from group** are always available; a freed part becomes its own single idea from its snapshot.
- Nothing is ever deleted by grouping or ungrouping; Delete on a group moves the whole group to the Trash.

### 3.7 Keyboard and playback

Parts behave as ordinary lines to the arrow keys; the group header is not a stop of its own.

- **↓ onto a collapsed group:** it expands automatically (marked *auto-opened*), the first part is highlighted and, with
  "play as I move" on, plays. **↑ onto a group from below:** it expands, the last part is highlighted and plays.
- **↓/↑ inside the group** moves part to part, then on to the next line; the neighbouring ideas behave as today.
- **Leaving an auto-opened group collapses it.** A group the user opened by hand with the caret **stays as the user left it**
  (open). Opening or closing by hand always wins and clears the auto-open mark.
- A part that ends plays the next part of the same group (and stops at the end of the group). Space plays or pauses; the
  group's play button plays the whole group from its first part.
- Select mode: ticking a group's checkbox (or any of its parts) selects the group, and so every part.
- **Random** picks an idea (a group counts once) and plays its first part. **Triage** shows one card per idea with its parts
  listed and autoplays the parts in order.

### 3.8 Resurface

Resurface works on groups. A group qualifies if it is hearted and none of its parts has been played for N days (never played
counts). It is always shown **fully expanded**, with all its parts, and *Surprise me* plays the group from its first part
onward. There is no way to resurface a single part of a group.

### 3.9 Search and filters

- All filters (tags, tempo range, key, marks, status) act on group-level fields, because that is where the details live.
- Text search covers the group's title, notes and tags **and its parts' labels** (any part).
- **The any/all-parts toggle** the owner suggested has nothing to apply to once the details are group-level: there is only one
  tempo, one key and one set of tags per group. It would only matter for search over part labels or the retained original
  data of the parts. Recommendation: **do not build the toggle**. If the owner still wants one, scope it to "search also looks
  at the original details kept on each part" (any part). The existing "has all / has any selected tags" choice stays and is
  unrelated.

### 3.10 Export, backup, portability

- Each exported group is one `.md` note whose front matter lists the group's details and its parts (file names and labels); the
  audio files sit beside it as `<date> <title> [group] - part N <label>.<ext>`. A single idea exports exactly as today. The
  group's title and id are also written into each part's file name so the association survives without the database.
- `index.csv` keeps one row per recording and gains group columns; `index.html` shows a group's parts together.
- The database copy still contains the retained per-recording data. The backup script needs no change. The restore drill and
  export tests must be extended with groups.

### 3.11 Migration (the risky part)

1. Add the new tables and columns, additively. Nothing is dropped or rewritten in `recordings`.
2. Back up first (the app already knows how); the deploy runbook adds "rehearse the migration on a copy of the real database"
   before the first deploy.
3. Backfill one group per recording, copying its title, tempo, key, notes, status, rating, used-in, tags, dates and
   trashed state; set `position` 0.
4. Verify: group count equals recording count; every tag, mark and date round-trips; the Library, Inbox, Trash and Resurface
   lists are identical before and after for a seeded database with trashed items, marks and tags.
5. Use numbered migrations (`PRAGMA user_version`), as already planned in the upkeep document.

Rollback: the old columns still exist, but edits made after the migration live on the groups, so an older version of the app
would not see them. To make a rollback lossless during the transition, single-idea edits can be **dual-written** to the
recording's own columns for a while and removed once the feature is trusted (optional).

### 3.12 Blast radius (why this is a large change)

`app/riffbox/__init__.py` has 34 places that read or write recordings; `library.py`, `exporter.py`, `backup.py` and `health.py`
touch them too. 16 server test files and 15 browser scripts call the recordings endpoints (`test_intake.py` alone has 56
calls). The row-building, selection, keyboard, Random, triage, Resurface and export code all change shape. The compatibility
alias for `PATCH /api/recordings/<id>` and a staged rollout (section 5) exist to keep each step small and testable.

## 4. Points where requirements interact

1. **"Stay closed"** (keyboard): read as "stay open" (7.1).
2. **Any/all toggle vs group-level details**: moot for the metadata filters (3.9).
3. **Group length:** longest part, not the sum (3.2); easy to change.
4. **Tempo/key at group level vs "retain their data":** resolved by the snapshot plus the grouping dialog (3.2, 3.5).
5. **Marks:** moved to the group (a mark describes the idea), with the strongest part mark offered when grouping.
6. **Ideas, not recordings, are counted** in tab counts and lists; the Backup page still reports both.
7. **The earlier "Songs tab / song chip" idea is dropped.** A group is the song; the ✓ mark and its "used in" text stay on the group.

## 5. Implementation plan (staged, on one branch `groups`, merged only when the owner says)

Each stage ends green (all server and browser tests, plus new ones) and is useful or invisible on its own.

1. **Data layer and migration, no visible change.** `idea_groups`, `group_tags`, `group_id`/`position`; the migration with its
   verification; `refresh_group`; `GET /api/groups` and `PATCH /api/groups/<id>`; the compatibility alias; the page switches to
   group rows but every group has one part, so it looks and behaves exactly as today. Tests: migration on a seeded old
   database (trash, marks, tags, dates), identical lists before and after, the existing suites adapted.
2. **Making and changing groups.** `POST /api/groups` (with the tempo/key/title/tags/notes dialog and its prefill rules),
   add/remove/ungroup/reorder parts, Select mode in the Inbox, the bulk **Group…** and **Add to group…**, group-level trash and
   restore, upload-as-one-idea, group Edit form with the Parts list.
3. **Looks.** Expandable rows (caret, badge, part rows), Compact and minimal theme, stable-layout checks, the player bar title
   ("Group: part 2 of 3"), part-to-part auto-advance.
4. **Keyboard and playback.** The auto-open / manual-open state machine, arrow navigation across parts, Random on ideas, triage
   cards with parts, select-all semantics.
5. **Resurface, search, export, docs.** Group-shaped Resurface with always-expanded groups, search over part labels, the exporter
   and its restore-drill tests, the How this works page, README, the deploy runbook (migration rehearsal), this plan's status.
6. **Optional later:** grouping suggestions from recording times; "download all parts (zip)"; playing parts together (a small
   mixer, which needs decoded audio in the browser and probably a manual offset per part).

Deploy gate (owner): a routine deploy plus, once, the migration rehearsal on a copy of the real database (`deploy/` runbook), a
check that the Library, Inbox and Trash look unchanged, then try grouping, expanding, keyboard navigation and Resurface on the
phone and the computer.

Effort: large, comparable to the whole Library browser phase. The riskiest parts are the migration (3.11), the number of places
that change at once (3.12) and the keyboard state machine (3.7); stages 1 and 4 are where most of the testing effort belongs.

## 6. Tests to write

Migration identity and idempotence; every API path (create, merge, add, remove, ungroup, trash, restore, bulk, resurface) with
all-or-nothing behaviour; denormalised values (earliest recorded, latest upload, longest length, last played) after every
membership change; the snapshot refresh and restore-on-ungroup; export and restore-drill with groups; browser tests for
grouping from Select mode in the Inbox and Library, upload-as-one-idea, expand and collapse, the keyboard rules (auto-opened
groups collapse, hand-opened ones stay), part auto-advance, Random and Resurface drawing whole groups, stable layout with
groups present, Compact and minimal theme, and a performance run with groups present (`tests/perf/measure.cjs`).

## 7. Open questions for the owner

1. **Keyboard:** "stay closed" meant "stay open" for a group the user opened by hand?
2. **Part labels:** is the recording's own title a good part label (editable), or should parts be labelled by a short role
   (keys, drums, vocal) chosen in the grouping dialog?
3. **Group length:** longest part (assumed) or the sum?
4. **Mixed statuses:** when grouping Inbox and Library items together, default to the Inbox (assumed)?
5. **Downloading a group:** individual part links first, zip later (assumed)?
6. **Auto-advance:** should a finished part also continue into the next part when playing with the mouse (assumed yes, within
   the group only)?
7. **The any/all toggle:** dropped (assumed), or kept for search over part labels and retained part data?
8. **Dual-write for lossless rollback** during the transition: wanted, or is a pre-migration backup enough?

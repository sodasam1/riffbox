# Groups: short manual checks, one list per stage

Run on a restored copy of your real data first, then on the live site. Each stage keeps the earlier lists.

## Stage 1: data layer and migration (no visible change)
- [ ] Counts match the live site (Inbox, Library, Trash, Resurface); spot-check 3 ideas (tags, marks, BPM, key, notes, dates). Restart twice and recheck.
- [ ] Edit an idea's tags, notes and key, mark one ♥, bulk-tag a few in Select mode: changes stick after reload.
- [ ] Trash an idea and restore it: tags and notes are back.
- [ ] Upload one file in the browser and one from the iPhone Shortcut: both land in the Inbox; a repeat is refused.
- [ ] A normal file and an Apple Lossless one play; a new upload gets its waveform and length.
- [ ] Rollback: start `main` on the migrated copy; it opens and shows your latest edits.

## Stage 2: making and changing groups
- [ ] Inbox: Select, tick 2–3 recordings, Group…. The dialog asks which tempo (and key) if they differ; the new idea shows "N parts" and lands where you chose.
- [ ] Select mode still behaves as before in the Library (tags, marks, Move to Inbox, Trash, Select all, shift-click).
- [ ] Edit a grouped idea: rename and reorder parts, Save; Take out one part; Break up this idea. Every recording is still there afterwards.
- [ ] Upload two files with "Upload several files as one idea" ticked: one idea with two parts in the Inbox; a normal multi-upload without the tick still makes separate ideas.
- [ ] Trash a grouped idea and restore it: all parts, tags and notes come back. (Until stage 3 a grouped row plays and downloads its first part only.)

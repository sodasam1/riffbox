# Groups: short manual checks, one list per stage

Run on a restored copy of your real data first, then on the live site. Each stage keeps the earlier lists.

## Stage 1: data layer and migration (no visible change)
- [ ] Counts match the live site (Inbox, Library, Trash, Resurface); spot-check 3 ideas (tags, marks, BPM, key, notes, dates). Restart twice and recheck.
- [ ] Edit an idea's tags, notes and key, mark one ♥, bulk-tag a few in Select mode: changes stick after reload.
- [ ] Trash an idea and restore it: tags and notes are back.
- [ ] Upload one file in the browser and one from the iPhone Shortcut: both land in the Inbox; a repeat is refused.
- [ ] A normal file and an Apple Lossless one play; a new upload gets its waveform and length.
- [ ] Rollback: start `main` on the migrated copy; it opens and shows your latest edits.

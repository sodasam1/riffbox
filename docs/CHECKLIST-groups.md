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
- [ ] Inbox: Select, tick 2–3 recordings, Group… (one click, no dialog). The idea shows "N parts" and lands in the Inbox if any part was there.
- [ ] Group two with different BPMs: the row shows ⚠ pick tempo; Edit lists both; picking one (or No tempo) and saving clears it. Same for keys.
- [ ] Cozy / Compact shows on the Inbox as well as the Library, and the choice applies to both.
- [ ] Library filters: "Needs a tempo or key choice · N" lists only flagged ideas; Clear filters resets it.
- [ ] Select mode still behaves as before in the Library (tags, marks, Move to Inbox, Trash, Select all, shift-click).
- [ ] Edit a grouped idea: rename and reorder parts, Save; Take out one part; Break up this idea. Every recording is still there afterwards.
- [ ] Upload two files with "Upload several files as one idea" ticked: one idea with two parts in the Inbox; a normal multi-upload without the tick still makes separate ideas.
- [ ] Trash a grouped idea and restore it: all parts, tags and notes come back. (Until stage 3 a grouped row plays and downloads its first part only.)

## Stage 3: how groups look and play
- [ ] A grouped idea is one row (caret, "N parts" badge; in Compact just the number). Singles look exactly as before.
- [ ] The caret opens the parts under the row (Cozy, Compact, minimal theme, phone). Each part plays and downloads on its own; opened ideas stay open after a change.
- [ ] The player names the part ("Idea — Part (part 2 of 3)"); when a part ends the next one starts, and it stops after the last.
- [ ] The idea's own ▶ plays the part you were on (else the first). Arrow keys still move row to row (parts are not stepped through until stage 4).

## Stage 4: keyboard, Random, Select and triage with groups
- [ ] Arrow ↓ onto a closed group opens it and plays part 1; ↓ walks its parts, then on to the next idea, and the group closes behind you. ↑ onto a group opens it on its last part.
- [ ] A group you opened with the caret stays open when you arrow past it; closing it with the caret closes it.
- [ ] h/c/x mark the whole idea while a part is highlighted; Space plays or pauses that part.
- [ ] Random never repeats the idea that is playing, and plays a group from its first part. Select: ticking a part ticks the idea; Select all counts ideas.
- [ ] Triage a grouped Inbox idea: the card lists its parts, and they play in order.

## Tab row and themes (small changes)
- [ ] Tab row reads as groups: Inbox / Library / Resurface, then Cozy / Compact, then Random, then Select (Random before Select), with clear space between.
- [ ] Menu → Style (Standard, Minimal) and Colors (Auto, Light, Dark) work independently and in any combination, and are remembered; Dark stays dark when the phone is set to light.

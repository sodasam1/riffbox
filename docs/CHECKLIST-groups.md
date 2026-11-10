# Groups: manual test checklists, one per stage

Run each list on a restored copy of your real data first (see the rehearsal steps in the stage's message), then again on
the live site after deploying. Tick what you checked; write down anything odd before changing more. Each new stage keeps
every earlier list: do "Always" plus the newest stage.

## Always (every stage)
Data and safety
- [ ] Counts match the live site before the change: Inbox, Library (with "All"), each mark filter, Trash, Resurface.
- [ ] A fresh export was taken before deploying; **Backup and export** page still builds a zip; Back up now still works.
- [ ] Pick 5 ideas you know well: title, tags, mark, "used in", BPM, key, notes, Recorded and Uploaded dates are unchanged.
Listening
- [ ] Play one WAV/MP3 and one Apple Lossless memo (Safari plays ALAC; Chrome shows the play copy or "preparing").
- [ ] Waveform, length, scrubbing, speed, A-B loop and Download (original file) work.
- [ ] Space plays/pauses; Up/Down arrows move and play; a recording counts as "played" only after a real listen.
Finding
- [ ] Search (title, notes, tag), tag filters (all/any), BPM slider, key, Show (marks) filter, Clear filters.
- [ ] Click-to-sort headings (asc, desc, back to default); Cozy/Compact; both themes (Menu).
- [ ] Random in Library and Inbox; Resurface list and Surprise me.
Changing things
- [ ] Edit an Inbox idea: Save partly (stays in Inbox) and Save and move to Library.
- [ ] Edit a Library idea: change tags/notes/BPM/key/date; Move back to Inbox.
- [ ] ♥ ✓ (with song name) ✗ marks; triage mode through a few Inbox items.
- [ ] Select mode: pick several, bulk add/remove tag, bulk mark, bulk Inbox, bulk Trash.
- [ ] Trash an idea, open Trash, Restore it: tags and notes are back.
Capture
- [ ] Upload one file in the browser (button) and one by drag-and-drop; the same file again is refused as a duplicate.
- [ ] Send one memo from the iPhone Outbox Shortcut; it lands in the Inbox and the Outbox copy is removed.
Phone
- [ ] Layout on the phone: header, tabs (no jumping), filters button, player bar, edit form fits.
- [ ] Logged out: the page asks for the passphrase; five wrong tries lock out (do this last).

## Stage 1: data layer and migration (no visible change)
- [ ] Rehearsal first: restore the export with `deploy/restore.py` into a scratch folder and start the branch on it.
- [ ] Nothing looks different anywhere; the "Always" list passes in full.
- [ ] Restart the service twice: counts and details are still identical (the migration is repeatable).
- [ ] Trash and Resurface contents match before/after; a trashed idea restores with its tags.
- [ ] A new upload and a new edit appear correctly (they are also written to the old columns for rollback).
- [ ] Rollback drill on the copy: start `main` on the migrated copy; it opens and shows your latest edits.

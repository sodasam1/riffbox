# Code upkeep: short manual checks (branch `code-upkeep`, on top of `speed-and-upkeep`)

Run after deploying (the routine deploy; nothing new on the server). Use the iPhone in Safari for the first three.

- [ ] **Looks identical:** Standard and Minimal, Auto/Light/Dark: the Library, an edit form, the menu and the player look as before (the screenshots were
      pixel-identical on the computer; this is the check on the phone).
- [ ] **Editing near the player (Safari):** play something, open Edit on a row near the bottom of the screen: the Title field is not hidden behind the
      player, and stays visible if the player bar grows or shrinks.
- [ ] **Taps land right (Safari):** scroll a long Library, tap ♥ / Edit / the play button on several rows: each does what it says (rows are no longer skipped when
      off screen in Safari, so nothing should jump).
- [ ] **Everything still starts:** the page loads from five script files (app, transport, triage, pages, boot): log in, play a recording, open Triage, open the
      Menu, then How this works and Backup and export.
- [ ] **Chrome on the computer:** scrolling a long Library is smooth, Select all and Cozy/Compact are instant.

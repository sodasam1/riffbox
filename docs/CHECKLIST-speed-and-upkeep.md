# Speed and upkeep: short manual checks (branch `speed-and-upkeep`)

Run these after deploying (the routine deploy; no new package, no config change).

- [ ] **Starts and migrates:** the page loads and you can log in. On the server, `/var/riffbox/before-migration/` now holds one `riffbox-v0-….db`
      (the copy kept before the first numbered migration) and restarting the service does not add another.
- [ ] **Nothing changed in your data:** Inbox, Library, Trash and Resurface counts and five ideas you know look the same as before.
- [ ] **Faster, same behaviour:** open the Library, press Select, Select all and Done, switch Cozy/Compact, scroll a long list quickly and
      jump with the arrow keys: no blank gaps, nothing jumps, rows you are editing or playing stay put. Check once on the iPhone in Safari.
- [ ] **Select mode:** tick rows (shift-click a range), the count is right, Group… and the tag/mark actions still work, Done clears the ticks.
- [ ] **Lists refresh after a change:** mark a ♥, edit a title, upload a file: the list shows it at once (the lists are re-checked every time).
- [ ] **Live headers (optional):** `curl.exe -sI` of the page and a fingerprinted file still show gzip and the cache header (see the earlier check).
- [ ] **Rollback still possible (optional):** on a restored copy, start the previous release on the migrated database; it opens (see `deploy/GROUPS.md`).

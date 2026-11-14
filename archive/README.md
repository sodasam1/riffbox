# Archive

Finished work, kept for reference. **Nothing here is needed to run, install, update or restore Riffbox**, and nothing was deleted: each
file is exactly as it was, moved here with `git mv`, so its full history is still in Git. You do not need to upload this folder to the server.

| Now here | It used to be | Why it is not active |
|---|---|---|
| `deploy/PHASE2.md` | `deploy/PHASE2.md` | The eleven-step first deploy by hand. Replaced by one file: `deploy/install.sh`, described in `deploy/INSTALL.md`. |
| `deploy/PHASE3_5.md` | `deploy/PHASE3_5.md` | Installing `ffmpeg` and FLAC play copies. `ffmpeg` is now installed by `install.sh` with the other packages. |
| `deploy/GROUPS.md` | `deploy/GROUPS.md` | The first deploy of groups (migration rehearsal, rollback). Groups are deployed and in use. |
| `docs/PLAN-groups.md` | `docs/PLAN-groups.md` | The design and staged plan for groups, which are built and deployed. Still the place to read why groups work as they do. |
| `docs/plan-original-2026-11-08.md` | `docs/archive/plan-original-2026-11-08.md` | The original plan, unchanged since 8 Nov 2026. |

Still in use and therefore **not** archived: `deploy/INSTALL.md`, `deploy/SHORTCUT.md`, `deploy/PHASE8.md` (the practice restore and export),
`deploy/UNINSTALL.md`, `docs/PLAN.md`, `docs/PLAN-performance-ux-sustainability.md` and the three `docs/CHECKLIST-*.md` files (they still hold checks
you have not ticked). `tests/` and `docs/` are for development: the installer does not copy them to the server.

Links inside the moved files that point to other files may now be slightly off; use the table above to find a file, or `git log --follow` on it.

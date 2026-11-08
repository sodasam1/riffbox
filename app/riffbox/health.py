"""The status line on the Backup and export page: is there room, is it growing, is it backed up?
`assess` is pure (made-up numbers in, verdict out) so every threshold is unit-tested; `collect` reads the real disk and
database and feeds it. No Flask."""
import datetime as dt
import os

GB = 1024 ** 3
MIN_HISTORY_DAYS = 14          # less history than this and a growth forecast would be a guess
LEVELS = ("ok", "warn", "bad")


def fmt_bytes(n):
    n = max(0, int(n))
    if n >= GB:
        return f"{n / GB:.1f} GB"
    if n >= 1024 ** 2:
        return f"{n / 1024 ** 2:.0f} MB"
    return f"{max(1, round(n / 1024)) if n else 0} KB"


def fmt_span(days):
    if days >= 730:
        return f"about {days / 365:.0f} years"
    if days >= 365:
        return "about a year"
    if days >= 60:
        return f"about {days / 30:.0f} months"
    return f"about {max(1, round(days))} days"


def assess(*, disk_total, disk_free, audio_bytes, original_bytes, recent_bytes, history_days,
           backup=None, backup_same_disk=False, backup_age_days=None, recordings=0):
    """Returns {"level", "summary", "items": [{"level", "text"}]}.

    disk_total / disk_free   the disk the data lives on
    audio_bytes              what the audio folder takes (originals plus FLAC play copies)
    original_bytes           the originals' sizes added up (the FLAC copies are the difference)
    recent_bytes             originals uploaded in the last `history_days` (capped at 90) days
    backup                   None if no backup folder is configured, else {"copies", "audio_missing", "audio_total"}
    backup_same_disk         the backup folder is on the same disk, so every recording is stored twice
    backup_age_days          days since the newest database copy (None if there is none)
    """
    items = []

    def add(level, text):
        items.append({"level": level, "text": text})

    free_share = disk_free / disk_total if disk_total else 1
    if disk_free < 1 * GB or free_share < 0.05:
        add("bad", f"Disk almost full: only {fmt_bytes(disk_free)} free of {fmt_bytes(disk_total)}. Uploads may start failing.")
    elif free_share < 0.10:
        add("warn", f"Disk getting full: {fmt_bytes(disk_free)} free of {fmt_bytes(disk_total)} ({free_share:.0%}).")

    summary = [f"{fmt_bytes(disk_free)} free of {fmt_bytes(disk_total)}", f"audio uses {fmt_bytes(audio_bytes)}"]
    days_left = None
    if history_days >= MIN_HISTORY_DAYS and recent_bytes > 0 and original_bytes > 0:
        overhead = max(1.0, audio_bytes / original_bytes)               # FLAC copies make each upload take more
        per_day = recent_bytes / history_days * overhead * (2 if backup_same_disk else 1)
        summary.append(f"growing by about {fmt_bytes(per_day * 30)} a month" +
                       (" (backups on the same disk count twice)" if backup_same_disk else ""))
        days_left = disk_free / per_day if per_day else None
        if days_left is not None:
            summary.append(f"room for {fmt_span(days_left)} at this pace")
            if days_left < 60:
                add("bad", f"At this pace the disk fills in {fmt_span(days_left)}.")
            elif days_left < 180:
                add("warn", f"At this pace the disk fills in {fmt_span(days_left)}.")
    elif recordings and history_days < MIN_HISTORY_DAYS:
        summary.append("too little history yet to forecast growth")

    if backup is None:
        add("warn", "No server backup is set up (the Back up now button is off). See the backup section below.")
    else:
        if not backup["copies"]:
            add("warn" if recordings else "ok", "No backup has been made yet.")
        elif backup_age_days is not None and backup_age_days > 14:
            add("bad", f"The last backup is {backup_age_days:.0f} days old.")
        elif backup_age_days is not None and backup_age_days > 3:
            add("warn", f"The last backup is {backup_age_days:.0f} days old.")
        if backup["audio_missing"]:
            add("warn", f"{backup['audio_missing']} of {backup['audio_total']} audio files are not backed up yet.")
        if backup_same_disk:
            add("ok", "The backup is on the same disk as your recordings, so it does not protect you if the server is "
                      "lost. Download the export now and then.")
    level = max((i["level"] for i in items), key=LEVELS.index, default="ok")
    if not any(i["level"] != "ok" for i in items):
        head = "Everything looks fine."
    else:
        head = next(i["text"] for i in sorted(items, key=lambda i: -LEVELS.index(i["level"])) if i["level"] != "ok")
    return {"level": level, "headline": head, "summary": " · ".join(summary), "items": items}


def _parse(stamp):
    return dt.datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)


def collect(conn, data_dir, audio_dir, backup_dir, backup, original_bytes, recordings, disk_usage):
    """Gather the real numbers (disk, audio folder, upload history, backup folder) and return assess()'s verdict.
    `conn` is an open database connection; `disk_usage(path)` returns (total, free) bytes."""
    total, free = disk_usage(data_dir)
    on_disk = sum(p.stat().st_size for p in audio_dir.iterdir() if p.is_file() and not p.name.startswith("."))
    now = dt.datetime.now(dt.timezone.utc)
    first = conn.execute("SELECT MIN(uploaded_at) FROM recordings").fetchone()[0]
    history = min(90.0, (now - _parse(first)).total_seconds() / 86400) if first else 0.0
    cutoff = (now - dt.timedelta(days=history)).strftime("%Y-%m-%dT%H:%M:%SZ")
    recent = conn.execute("SELECT COALESCE(SUM(size), 0) FROM recordings WHERE uploaded_at >= ?", (cutoff,)).fetchone()[0]
    same_disk, age = False, None
    if backup:
        try:
            same_disk = os.stat(backup_dir).st_dev == os.stat(data_dir).st_dev
        except OSError:
            pass
        if backup["latest"]:
            age = (now - _parse(backup["latest"])).total_seconds() / 86400
    return assess(disk_total=total, disk_free=free, audio_bytes=on_disk, original_bytes=original_bytes,
                  recent_bytes=recent, history_days=history, backup=backup, backup_same_disk=same_disk,
                  backup_age_days=age, recordings=recordings)

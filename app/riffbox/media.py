"""Media helpers: read the audio codec out of an MP4/M4A file (no dependencies), and convert to FLAC.

Why: Voice Memos set to "Lossless" records Apple Lossless (ALAC) inside an .m4a. Safari plays that;
Chrome, Edge and Firefox do not. ALAC -> FLAC is lossless both ways and FLAC plays in every browser,
so the server keeps the original untouched and makes a FLAC "play copy" for the player.
"""
import array
import struct
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

MAX_MOOV = 64 * 1024 * 1024        # refuse absurd metadata boxes

# Which container ffmpeg is told to expect, by file extension. Forcing it (instead of letting ffmpeg
# guess from the content) means a file cannot pose as something exotic, such as a playlist that points
# at other files.
INPUT_FORMAT = {".m4a": "mov", ".mp4": "mov", ".wav": "wav", ".mp3": "mp3", ".flac": "flac",
                ".ogg": "ogg", ".aac": "aac", ".aif": "aiff", ".aiff": "aiff", ".caf": "caf"}
ANALYSIS_RATE = 8000               # decode to 8 kHz mono: plenty for a waveform, and fast
WINDOW = 160                       # samples per window = 20 ms
PEAK_BINS = 200                    # points in the stored waveform


def _children(buf, start, end):
    """Yield (type, payload_start, payload_end) for the boxes packed between start and end."""
    pos = start
    while pos + 8 <= end:
        size, typ = struct.unpack_from(">I4s", buf, pos)
        header = 8
        if size == 1:
            if pos + 16 > end:
                return
            size = struct.unpack_from(">Q", buf, pos + 8)[0]
            header = 16
        elif size == 0:
            size = end - pos
        if size < header or pos + size > end:
            return                    # corrupt or truncated: stop rather than guess
        yield typ, pos + header, pos + size
        pos += size


def _find(buf, start, end, *path):
    """Follow a chain of box types and return the payload range of the last one, or None."""
    for typ in path:
        for t, s, e in _children(buf, start, end):
            if t == typ:
                start, end = s, e
                break
        else:
            return None
    return start, end


def _codec_from_moov(moov):
    for typ, s, e in _children(moov, 0, len(moov)):
        if typ != b"trak":
            continue
        hdlr = _find(moov, s, e, b"mdia", b"hdlr")
        if not hdlr or hdlr[1] - hdlr[0] < 12:
            continue
        if moov[hdlr[0] + 8: hdlr[0] + 12] != b"soun":
            continue                  # video or other track
        stsd = _find(moov, s, e, b"mdia", b"minf", b"stbl", b"stsd")
        if not stsd or stsd[1] - stsd[0] < 16:
            continue
        # stsd payload: version/flags (4) + entry count (4) + first entry: size (4) + format (4)
        fourcc = moov[stsd[0] + 12: stsd[0] + 16]
        if fourcc == b"alac":
            return "alac"
        if fourcc == b"mp4a":
            return "aac"
        return fourcc.decode("latin-1").strip().lower() or "unknown"
    return None


def mp4_audio_codec(path):
    """'alac', 'aac', another sample-entry name, or None if this is not a readable MP4 with audio."""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            fsize = fh.tell()
            pos = 0
            while pos + 8 <= fsize:
                fh.seek(pos)
                head = fh.read(16)
                if len(head) < 8:
                    return None
                size, typ = struct.unpack(">I4s", head[:8])
                header = 8
                if size == 1:
                    if len(head) < 16:
                        return None
                    size = struct.unpack(">Q", head[8:16])[0]
                    header = 16
                elif size == 0:
                    size = fsize - pos
                if size < header:
                    return None
                if typ == b"moov":
                    if size > MAX_MOOV:
                        return None
                    fh.seek(pos + header)
                    return _codec_from_moov(fh.read(size - header))
                pos += size
    except OSError:
        return None
    return None


def convert_to_flac(ffmpeg, src, dst, timeout=900):
    """Lossless conversion of the first audio stream to FLAC. Returns (ok, error_text)."""
    cmd = [
        ffmpeg, "-nostdin", "-v", "error", "-y",
        "-protocol_whitelist", "file",      # never fetch anything over the network
        "-f", "mov",                        # input is the MP4 family; no format guessing
        "-i", str(src),
        "-map", "0:a:0", "-vn", "-map_metadata", "-1",
        "-threads", "1",
        "-c:a", "flac",
        "-f", "flac", str(dst),
    ]
    try:
        done = subprocess.run(cmd, capture_output=True, timeout=timeout, text=True, errors="replace")
    except subprocess.TimeoutExpired:
        return False, "conversion timed out"
    except OSError as exc:
        return False, f"could not run ffmpeg: {exc}"
    if done.returncode != 0:
        return False, (done.stderr or "ffmpeg failed")[-500:]
    return True, ""


def summarize_pcm(chunks, rate=ANALYSIS_RATE, window=WINDOW, bins=PEAK_BINS):
    """Reduce raw audio to (length in seconds, waveform).

    `chunks` is any iterable of byte strings holding signed 16-bit little-endian mono samples, in any
    chunk sizes (a sample may be split between chunks). The waveform is up to `bins` integers from 0 to
    255, the loudest moment in each slice, scaled so the loudest slice in the whole recording is 255
    (so a quiet memo still draws a visible shape). Silence gives all zeros; no audio gives (0.0, []).
    """
    loudness = []                       # loudest sample in each 20 ms window
    pending_bytes = b""
    carry = array.array("h")
    total = 0
    for chunk in chunks:
        data = pending_bytes + chunk
        usable = len(data) - (len(data) % 2)
        pending_bytes = data[usable:]
        if not usable:
            continue
        samples = array.array("h")
        samples.frombytes(data[:usable])
        if sys.byteorder == "big":
            samples.byteswap()
        total += len(samples)
        carry.extend(samples)
        whole = len(carry) - (len(carry) % window)
        for i in range(0, whole, window):
            w = carry[i:i + window]
            loudness.append(max(max(w), -min(w)))
        del carry[:whole]
    if len(carry):
        loudness.append(max(max(carry), -min(carry)))
    if not loudness:
        return 0.0, []
    n = min(bins, len(loudness))
    pooled = [max(loudness[i * len(loudness) // n:(i + 1) * len(loudness) // n]) for i in range(n)]
    top = max(pooled)
    peaks = [round(255 * v / top) for v in pooled] if top > 0 else [0] * n
    return round(total / rate, 2), peaks


def analyze_audio(ffmpeg, src, timeout=900):
    """Decode `src` with ffmpeg and summarise it. Returns (ok, duration_s, peaks, error_text)."""
    fmt = INPUT_FORMAT.get(Path(src).suffix.lower())
    if fmt is None:
        return False, 0.0, [], "unsupported file type"
    cmd = [
        ffmpeg, "-nostdin", "-v", "error",
        "-protocol_whitelist", "file",      # never fetch anything over the network
        "-f", fmt, "-i", str(src),
        "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(ANALYSIS_RATE), "-threads", "1",
        "-f", "s16le", "pipe:1",
    ]
    with tempfile.TemporaryFile() as errors:        # a file, not a pipe: a chatty ffmpeg can't deadlock us
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errors)
        except OSError as exc:
            return False, 0.0, [], f"could not run ffmpeg: {exc}"
        watchdog = threading.Timer(timeout, proc.kill)
        watchdog.start()
        try:
            def stream():
                while True:
                    data = proc.stdout.read(65536)
                    if not data:
                        return
                    yield data
            duration, peaks = summarize_pcm(stream())
        finally:
            watchdog.cancel()
            proc.stdout.close()
        code = proc.wait()
        errors.seek(0)
        tail = errors.read()[-500:].decode("utf-8", "replace")
    if code != 0 or not peaks:
        return False, 0.0, [], tail or ("timed out or killed" if code else "no audio found")
    return True, duration, peaks, ""

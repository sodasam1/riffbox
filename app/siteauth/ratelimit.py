"""Attempt limiting. No Flask in here, so it is unit-tested with a fake clock. In memory only: a service restart clears it.

Limiter     after `per_key_max` failures from one client inside `window` seconds, that client must wait. Never blocks anyone else.
GlobalGate  when failures from ALL clients pile up (a spread-out guessing attack), it does not lock everyone out (the old riffbox
            behaviour let a stranger lock YOU out with 30 requests). It only asks the caller to slow down: one attempt at a time
            is delayed by `delay` seconds and at most `max_waiters` attempts wait at once.
"""
import threading
from collections import deque


def _prune(dq, now, window):
    while dq and now - dq[0] >= window:
        dq.popleft()


class Limiter:
    def __init__(self, clock, per_key_max=5, window=15 * 60, max_keys=1000):
        self._clock, self.per_key_max, self.window, self.max_keys = clock, per_key_max, window, max_keys
        self._lock = threading.Lock()
        self._by_key = {}

    def wait_for(self, key):
        """Seconds this client must wait (0 = allowed now)."""
        now = self._clock()
        with self._lock:
            if len(self._by_key) > self.max_keys:
                for k in list(self._by_key):
                    _prune(self._by_key[k], now, self.window)
                    if not self._by_key[k]:
                        del self._by_key[k]
            mine = self._by_key.get(key)
            if mine is None:
                return 0
            _prune(mine, now, self.window)
            if not mine:
                del self._by_key[key]
                return 0
            if len(mine) >= self.per_key_max:
                return int(self.window - (now - mine[0])) + 1
            return 0

    def failed(self, key):
        with self._lock:
            self._by_key.setdefault(key, deque()).append(self._clock())

    def succeeded(self, key):
        with self._lock:
            self._by_key.pop(key, None)


class GlobalGate:
    def __init__(self, clock, soft_max=30, window=15 * 60, delay=2.0, max_waiters=2):
        self._clock, self.soft_max, self.window, self.delay = clock, soft_max, window, delay
        self._lock = threading.Lock()
        self._fails = deque()
        self._sem = threading.Semaphore(max_waiters)

    def note_failure(self):
        with self._lock:
            self._fails.append(self._clock())

    def under_pressure(self):
        now = self._clock()
        with self._lock:
            _prune(self._fails, now, self.window)
            return len(self._fails) >= self.soft_max

    def try_enter(self):
        """True if this attempt may proceed (after sleeping `delay`); False = too many are already waiting, answer 429."""
        return self._sem.acquire(blocking=False)

    def leave(self):
        self._sem.release()

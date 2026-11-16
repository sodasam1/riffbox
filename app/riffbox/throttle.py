"""Login throttling.
 - one client: after LOGIN_PER_CLIENT_MAX wrong passphrases inside LOGIN_WINDOW seconds, THAT client is refused until the oldest
   failure ages out.
 - everyone together: after LOGIN_GLOBAL_MAX wrong passphrases from anyone inside the window (a guessing attack spread over many
   addresses) logins are SLOWED, not refused: the caller waits LOGIN_SLOW_DELAY seconds, and at most LOGIN_SLOW_WAITERS attempts wait at
   once (the rest get 429 for a moment). Before this change a stranger could lock the owner out with 30 requests.
In memory only: a service restart clears it. No Flask in here, so it is unit-tested with a fake clock."""
import threading
from collections import deque

LOGIN_WINDOW = 15 * 60
LOGIN_PER_CLIENT_MAX = 5
LOGIN_GLOBAL_MAX = 30                # failures from anyone before logins are slowed
LOGIN_SLOW_DELAY = 2.0
LOGIN_SLOW_WAITERS = 2
MAX_TRACKED_CLIENTS = 1000          # bounds memory if someone spreads failures over many addresses


def _prune(failures, now):
    while failures and now - failures[0] >= LOGIN_WINDOW:
        failures.popleft()


class LoginThrottle:
    def __init__(self, clock):
        self._clock = clock            # a callable, looked up at each use so tests can swap the clock
        self._lock = threading.Lock()
        self._by_client = {}           # client key -> deque of failure times
        self._global = deque()
        self._slow = threading.Semaphore(LOGIN_SLOW_WAITERS)

    def wait_for(self, key):
        """Seconds this client must wait before trying again (0 = allowed now)."""
        now = self._clock()
        with self._lock:
            if len(self._by_client) > MAX_TRACKED_CLIENTS:
                for k in list(self._by_client):
                    _prune(self._by_client[k], now)
                    if not self._by_client[k]:
                        del self._by_client[k]
            mine = self._by_client.get(key)
            if mine is not None:
                _prune(mine, now)
                if not mine:
                    del self._by_client[key]
            wait = 0
            if mine and len(mine) >= LOGIN_PER_CLIENT_MAX:
                wait = LOGIN_WINDOW - (now - mine[0])
            return int(wait) + 1 if wait > 0 else 0

    def under_pressure(self):
        """True while failures from all clients together are at or over LOGIN_GLOBAL_MAX (a spread-out guessing attack)."""
        now = self._clock()
        with self._lock:
            _prune(self._global, now)
            return len(self._global) >= LOGIN_GLOBAL_MAX

    def try_slow(self):
        """Take one of the few places in the slow lane. False = it is full: answer 429 for a moment."""
        return self._slow.acquire(blocking=False)

    def leave_slow(self):
        self._slow.release()

    def failed(self, key):
        now = self._clock()
        with self._lock:
            self._by_client.setdefault(key, deque()).append(now)
            self._global.append(now)

    def succeeded(self, key):
        with self._lock:
            self._by_client.pop(key, None)

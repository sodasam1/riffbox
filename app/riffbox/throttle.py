"""Login throttling: after LOGIN_PER_CLIENT_MAX wrong passphrases from one client (or LOGIN_GLOBAL_MAX from anyone)
inside LOGIN_WINDOW seconds, logins are refused until the oldest failure ages out. In memory only: a service restart
clears it. No Flask in here, so it is unit-tested with a fake clock."""
import threading
from collections import deque

LOGIN_WINDOW = 15 * 60
LOGIN_PER_CLIENT_MAX = 5
LOGIN_GLOBAL_MAX = 30
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
            _prune(self._global, now)
            wait = 0
            if mine and len(mine) >= LOGIN_PER_CLIENT_MAX:
                wait = max(wait, LOGIN_WINDOW - (now - mine[0]))
            if len(self._global) >= LOGIN_GLOBAL_MAX:
                wait = max(wait, LOGIN_WINDOW - (now - self._global[0]))
            return int(wait) + 1 if wait > 0 else 0

    def failed(self, key):
        now = self._clock()
        with self._lock:
            self._by_client.setdefault(key, deque()).append(now)
            self._global.append(now)

    def succeeded(self, key):
        with self._lock:
            self._by_client.pop(key, None)

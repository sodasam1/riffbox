"""siteauth: one owner login for every app on the site (approach C in docs/MULTI-APP.md).

The central login service (kit/login) checks your passphrase once and sets one signed cookie per app path. Each app uses THIS module
to verify its own cookie with its OWN key, so a break-in to one app cannot forge a login for another. Standard parts only: Flask,
Werkzeug (password hashes) and itsdangerous (signed cookies). Nothing here does cryptography of its own.
"""
from .core import SiteAuth, safe_next, make_token, read_token, undeclared_routes   # noqa: F401
from .ratelimit import Limiter, GlobalGate                                          # noqa: F401
from . import keys                                                                  # noqa: F401

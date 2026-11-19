"""Passphrase hashing: one place, no Flask (so installers can use it with nothing but Python and Werkzeug).

Only a salted, slow hash of the passphrase is ever stored (never the passphrase itself). The work is done by Werkzeug's
`generate_password_hash` / `check_password_hash` (part of Flask, nothing extra to install): a long-standing, widely used
implementation, so this file contains no cryptography of its own.

Method, in order of preference (the choice is written inside the hash string, so verifying always follows it):
  scrypt   N=2**16, r=8, p=2  (about 64 MiB of memory per check; the memory-hard function the OWASP password cheat sheet ranks after
           Argon2id), used when Python's hashlib has it
  PBKDF2-HMAC-SHA256, 600,000 rounds   (the standard, FIPS-era fallback; always available)
Python's hashlib needs OpenSSL for scrypt, and OpenBSD ships LibreSSL, which may lack it: hence the fallback. Parameters were chosen from
OWASP guidance read secondhand (see docs/AUTH.md) and are meant to be raised when hardware allows: old hashes keep verifying.
"""
import hashlib

from werkzeug.security import check_password_hash, generate_password_hash

SCRYPT = "scrypt:65536:8:2"
PBKDF2 = "pbkdf2:sha256:600000"
MIN_LENGTH = 15                 # NIST SP 800-63B-4: 15 when a password is the only factor. Checked when one is chosen, not when verifying


def default_method():
    return SCRYPT if hasattr(hashlib, "scrypt") else PBKDF2


def hash_passphrase(passphrase, method=None, check_length=True):
    if check_length and len(passphrase) < MIN_LENGTH:
        raise ValueError(f"the passphrase must be at least {MIN_LENGTH} characters (a long random one is best)")
    return generate_password_hash(passphrase, method=method or default_method())


def verify(stored_hash, supplied):
    """True only if `supplied` matches `stored_hash`. Never raises: a damaged or unsupported hash is simply 'no'."""
    try:
        return bool(stored_hash) and check_password_hash(stored_hash, supplied)
    except (ValueError, TypeError, AttributeError):
        return False

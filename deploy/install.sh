#!/bin/sh
# Riffbox: one-file installer for an OpenBSD server built with Tech Independence. The logic is shared with every app (deploy/appkit.sh);
# what is Riffbox's own is in deploy/app.manifest and deploy/hooks.sh.
#
#   doas sh ~/riffbox/deploy/install.sh --check       show what it would do; change nothing
#   doas sh ~/riffbox/deploy/install.sh               create what is MISSING; leave everything that already exists alone
#   doas sh ~/riffbox/deploy/install.sh --repair      also fix what exists but is wrong (shows each change, asks first)
#   doas sh ~/riffbox/deploy/install.sh --app-files-only   only copy the app code into place and restart (touches no system file)
#   add --yes to answer "yes" to every question
#
# Run it from the Riffbox folder you uploaded (the one that contains app/, static/ and deploy/). It never overwrites an existing
# /etc/riffbox.conf (that file holds your secrets) and never touches httpd, pf, mail, Radicale or DNS. The same steps, by hand,
# are in deploy/INSTALL.md, so you are never dependent on this script.
# Test hooks (kept from the old installer): RIFFBOX_TEST_ROOT, RIFFBOX_TEST_ANSWER, RIFFBOX_TEST_PYTHON.
[ -n "${RIFFBOX_TEST_ROOT:-}" ] && export APPKIT_TEST_ROOT="$RIFFBOX_TEST_ROOT"
[ -n "${RIFFBOX_TEST_ANSWER:-}" ] && export APPKIT_TEST_ANSWER="$RIFFBOX_TEST_ANSWER"
[ -n "${RIFFBOX_TEST_PYTHON:-}" ] && export APPKIT_TEST_PYTHON="$RIFFBOX_TEST_PYTHON"
. "$(dirname "$0")/appkit.sh"
appkit_main "$@"

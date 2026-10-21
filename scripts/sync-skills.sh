#!/usr/bin/env bash
#
# sync-skills.sh — refresh this bundle's PUBLIC skill from the live machine, and
# refuse to let proprietary or personal content leak into the public repo.
#
# Only the generic `automation-chrome` skill ships in this (public) bundle. The
# `razz-website-editor-automation` skill is deliberately NOT synced here: it
# contains the reverse-engineered MyRazz DDP API catalog and lives in the
# private Razz-Auditor repo instead.
#
# Workflow:
#   1. Copies ~/.cursor/skills/automation-chrome into skills/ here.
#   2. Greps the result against a denylist of personal/client tokens.
#   3. Exits non-zero if anything matched, so you sanitize before committing.
#      (The live skill legitimately carries a Salesforce/SSO hand-off note that
#      must be generalized before it can be published — this is the guard that
#      makes you do it every time.)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE_SKILLS="$HOME/.cursor/skills"
BUNDLE_SKILLS="$REPO_DIR/skills"
SKILL="automation-chrome"

# Precise denylist: person names, client names, and internal systems. Generic
# security words (e.g. "passkey", "MFA") are intentionally NOT listed.
DENYLIST='victor|inhabitiq|salesforce|lightning\.force|azuread|frontdoor|resman|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

[[ -d "$LIVE_SKILLS/$SKILL" ]] || die "live skill not found: $LIVE_SKILLS/$SKILL"

say "Copying $SKILL from $LIVE_SKILLS"
rm -rf "${BUNDLE_SKILLS:?}/$SKILL"
mkdir -p "$BUNDLE_SKILLS/$SKILL"
cp -R "$LIVE_SKILLS/$SKILL/." "$BUNDLE_SKILLS/$SKILL/"

say "Scanning for personal / proprietary tokens"
if rg -ni "$DENYLIST" "$BUNDLE_SKILLS/$SKILL"; then
  echo
  die "Denylisted content above was copied from the live skill.
       Sanitize skills/$SKILL/ (generalize the SSO/Salesforce hand-off note,
       remove names and internal hostnames) and re-run before committing."
fi

say "OK — $SKILL is clean and ready to commit"

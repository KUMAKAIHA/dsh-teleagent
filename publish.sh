#!/bin/sh
# Publish dsh-teleagent to npm.
#
# Requires an npm account with publish rights for this name. Sign in first:
#   npm login
# or export a token:
#   export NPM_TOKEN=npm_xxx    # then: npm publish --//registry.npmjs.org/:_authToken=$NPM_TOKEN
#
# After publishing, the package can be installed in DSH by name:
#   dsh plugin --profile <name> add dsh-teleagent
# or from the plugin manager's install box: dsh-teleagent
set -e

echo "→ running offline checks"
node regression.mjs

echo "→ verifying package contents"
npm pack --dry-run

if ! npm whoami >/dev/null 2>&1; then
  echo "✗ not signed in to npm. Run 'npm login' first (or set NPM_TOKEN)." >&2
  exit 1
fi

echo "→ publishing as $(npm whoami)"
npm publish --access public
echo "✓ published. Install with: dsh plugin --profile <profile> add dsh-teleagent"

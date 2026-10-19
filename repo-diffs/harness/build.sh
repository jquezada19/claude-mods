#!/bin/zsh
# Bundles the layout harness: the mod's real ui.render hook, painted as DOM.
# Then serve this folder (python3 -m http.server 8765 --bind 127.0.0.1 --directory <here>) and open it.
here=${0:A:h}
# gen/register.tsx: hooks/register.tsx verbatim, its relative imports pointed
# back at hooks/, plus one export so the harness can run the mod's own
# loadRest (the per-file containers' diff cache) against the mocked git
mkdir -p $here/gen
sed -e "s#from '\./#from '../../hooks/#" -e "s#from '\.\./types'#from '../../types'#" $here/../hooks/register.tsx > $here/gen/register.tsx || exit 1
print '\nexport { loadRest }' >> $here/gen/register.tsx
cd $here && npx --yes esbuild@0.24.0 entry.tsx --bundle --format=iife --jsx-factory=h --jsx-fragment=Fragment \
  --alias:claude-code=$here/shim.ts --outfile=bundle.js --log-level=warning

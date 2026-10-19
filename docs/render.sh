#!/bin/zsh
# Rewrites every <mod>/docs/*.svg from the mods' own drawing code (docs/render.ts).
here=${0:A:h}
out=$(mktemp -d) || exit 1
trap 'rm -rf $out' EXIT
print 'export {}' > $out/claude-code.ts
npx --yes esbuild@0.24.0 $here/render.ts --bundle --platform=node --format=esm \
  --alias:claude-code=$out/claude-code.ts --outfile=$out/render.mjs --log-level=warning || exit 1
node $out/render.mjs ${here:h}

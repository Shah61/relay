#!/bin/zsh
cd -- "${0:A:h}" || exit 1
if ! command -v node >/dev/null 2>&1; then
  print 'Install Node.js 22.18 or newer, then open this launcher again.'
  read '?Press Enter to close.'
  exit 1
fi
node --experimental-strip-types scripts/start.ts

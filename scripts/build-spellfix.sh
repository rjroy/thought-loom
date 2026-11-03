#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Official SQLite public-domain ext/misc/spellfix.c, revision
# https://github.com/sqlite/sqlite/blob/6932c59ee5c280599dfae9e7b431698a7cab9687/ext/misc/spellfix.c
printf '%s  %s\n' 'b961fe17a2fe7082a4a8c7a2676d16ea5450a9021b8b604ff446267312652c51' 'vendor/sqlite/spellfix.c' | sha256sum -c -
mkdir -p build/sqlite
"${CC:-cc}" -O2 -fPIC -shared vendor/sqlite/spellfix.c -o build/sqlite/spellfix.so
printf '%s\n' 'Built build/sqlite/spellfix.so (requires a compatible Bun SQLite runtime).'

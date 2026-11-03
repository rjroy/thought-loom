#!/usr/bin/env bash

# Setup script location and run from project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Initialize run specific env
export THOUGHTLOOM_USER_TOKEN="$(bun -e 'console.log(crypto.randomUUID())')"
export THOUGHTLOOM_AI_TOKEN="$(bun -e 'console.log(crypto.randomUUID())')"
export THOUGHTLOOM_DB_PATH="$PWD/.data/thoughtloom.sqlite"
export THOUGHTLOOM_PORT=3001
export THOUGHTLOOM_DAEMON_URL="http://127.0.0.1:$THOUGHTLOOM_PORT"

# perform pre-run checks
bun install --frozen-lockfile
bun test
bun run typecheck

# create the daemon launch script for this run
DAEMON_SH="$SCRIPT_DIR/daemon.local.sh"
echo "#!/usr/bin/env bash" > $DAEMON_SH
echo >> $DAEMON_SH
echo "export THOUGHTLOOM_USER_TOKEN=$THOUGHTLOOM_USER_TOKEN" >> $DAEMON_SH
echo "export THOUGHTLOOM_AI_TOKEN=$THOUGHTLOOM_AI_TOKEN" >> $DAEMON_SH
echo "export THOUGHTLOOM_DB_PATH=$THOUGHTLOOM_DB_PATH" >> $DAEMON_SH
echo "export THOUGHTLOOM_PORT=$THOUGHTLOOM_DB_PATH" >> $DAEMON_SH
echo "export THOUGHTLOOM_DAEMON_URL=$THOUGHTLOOM_DAEMON_URL" >> $DAEMON_SH
echo >> $DAEMON_SH
echo "bun run daemon" >> $DAEMON_SH
chmod +x $DAEMON_SH

# create the base demo scropt for this run
DEMO_SH="$SCRIPT_DIR/demo.local.sh"
echo "#!/usr/bin/env bash" > $DEMO_SH
echo >> $DEMO_SH
echo "export THOUGHTLOOM_USER_TOKEN=$THOUGHTLOOM_USER_TOKEN" >> $DEMO_SH
echo "export THOUGHTLOOM_AI_TOKEN=$THOUGHTLOOM_AI_TOKEN" >> $DEMO_SH
echo "export THOUGHTLOOM_DB_PATH=$THOUGHTLOOM_DB_PATH" >> $DEMO_SH
echo "export THOUGHTLOOM_PORT=$THOUGHTLOOM_DB_PATH" >> $DEMO_SH
echo "export THOUGHTLOOM_DAEMON_URL=$THOUGHTLOOM_DAEMON_URL" >> $DEMO_SH
echo >> $DEMO_SH
echo "bun run demo" >> $DEMO_SH
echo "bun run api --role user  GET /thoughts" >> $DEMO_SH
chmod +x $DEMO_SH

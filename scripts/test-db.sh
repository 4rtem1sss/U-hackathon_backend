#!/usr/bin/env bash
# Start a throwaway local PostgreSQL 16 for tests (no Docker needed).
#
#   eval "$(scripts/test-db.sh start)"   # exports DATABASE_URL and TEST_DB_DIR
#   pnpm test
#   scripts/test-db.sh stop              # stops the server and deletes the data dir
#
# Data lives in a temp dir; the server listens on 127.0.0.1 on a free port with
# trust auth. Never use this for anything but local tests.
#
# Env overrides: PG_BIN (default /usr/lib/postgresql/16/bin), TEST_DB_PORT,
# TEST_DB_NAME (default p2p_test), TEST_DB_DIR (for `stop`).
set -euo pipefail

PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
DB_NAME="${TEST_DB_NAME:-p2p_test}"
STATE_FILE="${TMPDIR:-/tmp}/u-hackathon-test-db.dir"

die() { echo "test-db: $*" >&2; exit 1; }

free_port() {
  if [[ -n "${TEST_DB_PORT:-}" ]]; then echo "$TEST_DB_PORT"; return; fi
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

# initdb/postgres refuse to run as root; drop to an unprivileged user if needed.
as_pg() {
  if [[ "$(id -u)" == "0" ]]; then
    local u="${TEST_DB_USER:-nobody}"
    if command -v runuser >/dev/null 2>&1; then
      runuser -u "$u" -- "$@"
    else
      su -s /bin/sh "$u" -c "$(printf '%q ' "$@")"
    fi
  else
    "$@"
  fi
}

start() {
  [[ -x "$PG_BIN/initdb" ]] || die "initdb not found in $PG_BIN (set PG_BIN)"
  local dir port
  dir="$(mktemp -d "${TMPDIR:-/tmp}/u-hackathon-pg.XXXXXX")"
  chmod 755 "$dir"
  if [[ "$(id -u)" == "0" ]]; then chown "${TEST_DB_USER:-nobody}" "$dir"; fi
  port="$(free_port)"

  as_pg "$PG_BIN/initdb" -D "$dir/data" -U postgres -A trust -E UTF8 --no-locale >"$dir/initdb.log" 2>&1 \
    || { cat "$dir/initdb.log" >&2; die "initdb failed"; }
  as_pg "$PG_BIN/pg_ctl" -D "$dir/data" -l "$dir/server.log" -w -t 30 \
    -o "-p $port -k $dir -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off" \
    start >/dev/null || { cat "$dir/server.log" >&2; die "pg_ctl start failed"; }
  as_pg "$PG_BIN/createdb" -h 127.0.0.1 -p "$port" -U postgres "$DB_NAME"

  echo "$dir" >"$STATE_FILE"
  echo "export TEST_DB_DIR='$dir'"
  echo "export DATABASE_URL='postgresql://postgres@127.0.0.1:$port/$DB_NAME'"
  echo "test-db: started on port $port (data: $dir)" >&2
}

stop() {
  local dir="${TEST_DB_DIR:-}"
  if [[ -z "$dir" && -f "$STATE_FILE" ]]; then dir="$(cat "$STATE_FILE")"; fi
  [[ -n "$dir" && -d "$dir/data" ]] || die "no running test db found (set TEST_DB_DIR)"
  as_pg "$PG_BIN/pg_ctl" -D "$dir/data" -m fast -w stop >/dev/null || true
  rm -rf "$dir" "$STATE_FILE"
  echo "test-db: stopped and removed $dir" >&2
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  *) die "usage: $0 [start|stop]" ;;
esac

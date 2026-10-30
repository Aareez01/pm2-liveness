#!/usr/bin/env bash
# End-to-end: break an instance, assert pm2-liveness restarts ONLY that instance and
# that the wire contract reaches a separate subscriber process.
#
# PM2_HOME must be SHORT. PM2 binds $PM2_HOME/rpc.sock and Linux caps unix socket
# paths at 107 chars; over that the bind fails silently, no .sock is created, and
# every pm2 command blocks forever with no error. Assert it rather than hang.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIX="$ROOT/test/integration/fixtures"
export PM2_HOME="${PM2_HOME_OVERRIDE:-$HOME/.pm2-liveness-it}"
PM2="$ROOT/node_modules/.bin/pm2"
P() { timeout 45 "$PM2" "$@"; }

FAILED=0
ok()   { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }
hr()   { echo; echo "---------- $1 ----------"; }

SOCK="$PM2_HOME/rpc.sock"
if [ ${#SOCK} -ge 107 ]; then
  echo "FATAL: PM2_HOME too long (${#SOCK} >= 107). pm2 would hang. Set PM2_HOME_OVERRIDE."
  exit 1
fi

if [ ! -f "$ROOT/dist/index.js" ]; then
  echo "FATAL: dist/index.js missing - run 'npm run build' first."
  exit 1
fi

cleanup() { P kill >/dev/null 2>&1; }
trap cleanup EXIT

hr "setup"
P kill >/dev/null 2>&1; rm -rf "$PM2_HOME"; mkdir -p "$PM2_HOME"
P ping >/dev/null 2>&1 || { echo "FATAL: daemon did not start"; exit 1; }
[ -S "$PM2_HOME/rpc.sock" ] && ok "daemon bound its sockets" || fail "no rpc.sock"

cd "$FIX" || exit 1
P start ecosystem.config.js >/dev/null 2>&1
P start "$FIX/listener.js" --name probe-listener >/dev/null 2>&1

# Run the module the way PM2 runs it, with module config in the environment.
APPS='{"probe-fixture":{"action":"restart","minHealthy":0,"liveness":{"http":{"path":"/health"},"periodSeconds":2,"timeoutSeconds":1,"failureThreshold":2}}}'
apps="$APPS" logLevel=debug reconcileSeconds=5 \
  P start "$ROOT/dist/index.js" --name pm2-liveness >/dev/null 2>&1
sleep 6

hr "baseline"
curl -s -m 2 http://127.0.0.1:3100/health >/dev/null && ok "instance :3100 healthy" || fail ":3100 unhealthy"
curl -s -m 2 http://127.0.0.1:3101/health >/dev/null && ok "instance :3101 healthy" || fail ":3101 unhealthy"

PID_BEFORE_0=$(P jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const l=JSON.parse(s);const p=l.find(x=>x.name==="probe-fixture"&&x.pm_id===0);console.log(p?p.pid:"")})')
PID_BEFORE_1=$(P jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const l=JSON.parse(s);const p=l.find(x=>x.name==="probe-fixture"&&x.pm_id===1);console.log(p?p.pid:"")})')

hr "break :3101 (pm_id 1)"
curl -s -m 2 http://127.0.0.1:3101/break >/dev/null
sleep 12

PID_AFTER_0=$(P jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const l=JSON.parse(s);const p=l.find(x=>x.name==="probe-fixture"&&x.pm_id===0);console.log(p?p.pid:"")})')
PID_AFTER_1=$(P jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const l=JSON.parse(s);const p=l.find(x=>x.name==="probe-fixture"&&x.pm_id===1);console.log(p?p.pid:"")})')

hr "assertions"
[ -n "$PID_BEFORE_1" ] && [ "$PID_BEFORE_1" != "$PID_AFTER_1" ] \
  && ok "failing instance pm_id=1 was restarted ($PID_BEFORE_1 -> $PID_AFTER_1)" \
  || fail "pm_id=1 was NOT restarted"

[ "$PID_BEFORE_0" = "$PID_AFTER_0" ] \
  && ok "healthy instance pm_id=0 was left alone (pid $PID_AFTER_0)" \
  || fail "pm_id=0 was restarted but should not have been"

curl -s -m 2 http://127.0.0.1:3101/health | grep -q '"ok":true' \
  && ok "restarted instance serves healthy again" || fail ":3101 still unhealthy"

if P logs probe-listener --nostream --lines 50 2>/dev/null | grep -q '"state":"fail"'; then
  ok "wire contract reached a separate subscriber process"
else
  fail "no pm2-liveness:status event observed by the listener"
fi

if P logs pm2-liveness --nostream --lines 80 2>/dev/null | grep -q 'restarting instance'; then
  ok "module logged the restart decision"
else
  fail "module did not log a restart decision"
fi

hr "module log"
P logs pm2-liveness --nostream --lines 25 2>/dev/null | grep -v '^$' | tail -15

echo
[ "$FAILED" -eq 0 ] && echo "INTEGRATION: ALL PASSED" || echo "INTEGRATION: FAILURES"
exit $FAILED

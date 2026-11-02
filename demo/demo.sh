#!/usr/bin/env bash
# A two-instance app. One instance starts returning 503 while its process stays
# alive. PM2 sees nothing wrong. pm2-liveness restarts that instance, and only
# that instance.
#
# Self-contained: isolated PM2_HOME, loopback ports, cleans up after itself.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
export PM2_HOME="${PM2_HOME_OVERRIDE:-$HOME/.pm2-demo}"
PM2="${PM2_BIN:-pm2}"
P() { timeout 90 "$PM2" "$@"; }

say()  { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
run()  { printf '\033[2m$ %s\033[0m\n' "$*"; eval "$@"; }
pids() { P jlist 2>/dev/null | node -pe '
  JSON.parse(require("fs").readFileSync(0,"utf8")).filter(x=>x.name==="api")
    .sort((a,b)=>a.pm_id-b.pm_id)
    .map(x=>`  instance ${x.pm_id}  pid ${x.pid}  up ${Math.round((Date.now()-x.pm2_env.pm_uptime)/1000)}s`).join("\n")'; }

trap 'P delete all >/dev/null 2>&1; P kill >/dev/null 2>&1' EXIT
P kill >/dev/null 2>&1; rm -rf "$PM2_HOME"; mkdir -p "$PM2_HOME"

say "1. Start an app with two instances"
run "P start '$HERE/ecosystem.config.js'" >/dev/null 2>&1
sleep 3
pids

say "2. Install pm2-liveness and point it at /health"
run "P install pm2-liveness" >/dev/null 2>&1
run "P set pm2-liveness:apps '{\"api\":{\"action\":\"restart\",\"minHealthy\":0,\"liveness\":{\"http\":{\"path\":\"/health\"},\"periodSeconds\":2,\"failureThreshold\":2}}}'" >/dev/null 2>&1
P set pm2-liveness:reconcileSeconds 3 >/dev/null 2>&1
sleep 6
echo "  watching /health on every instance, every 2s"

say "3. Break instance 1 - it returns 503 but the process stays alive"
run "curl -s http://127.0.0.1:3001/break"
echo
echo "  PM2's own view, which is the whole problem:"
P jlist 2>/dev/null | node -pe '
  JSON.parse(require("fs").readFileSync(0,"utf8")).filter(x=>x.name==="api")
    .sort((a,b)=>a.pm_id-b.pm_id)
    .map(x=>`  instance ${x.pm_id}  status ${x.pm2_env.status}  restarts ${x.pm2_env.restart_time}`).join("\n")'
echo "  ...both still 'online'. PM2 only sees crashes and memory limits."

say "4. pm2-liveness notices, and restarts only the broken instance"
for i in $(seq 1 25); do
  P logs pm2-liveness --nostream --lines 20 2>/dev/null | grep -q "restarting instance" && break
  sleep 1
done
P logs pm2-liveness --nostream --lines 20 2>/dev/null \
  | grep -oE '\{"ts".*restarting instance.*' | head -1 \
  | node -pe 'const j=JSON.parse(require("fs").readFileSync(0,"utf8").trim()||"{}");
      `  ${j.msg}  app=${j.app} pm_id=${j.pm_id} reason=${j.reason}`' 2>/dev/null
sleep 4
pids
echo
echo "  instance 1 has a new pid and a reset uptime. Instance 0 was never touched."

say "5. And it is serving again"
run "curl -s http://127.0.0.1:3001/health"
echo

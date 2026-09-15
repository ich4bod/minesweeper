#!/usr/bin/env bash
#
# Sequences the three phases of tools/verify-pwa.js around a real outage.
#
#   tools/verify-offline.sh [url]
#
# Phase 1 primes a persistent browser profile against the live site. The
# container is then STOPPED, and phase 2 loads and plays the game with nothing
# behind Traefik at all — the only way a board can render is out of the service
# worker's Cache API. Phase 3 brings the server back, with a marker freshly
# appended to style.css inside the running container, and checks the page sees
# the new byte rather than the cached copy. That last one is the card's kill
# condition, tested rather than argued.
#
# The container is restored on every exit path, including failure.
set -uo pipefail

APP=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
URL=${1:-https://minesweeper.ichabod-crane.net/}
IMAGE=mcr.microsoft.com/playwright:v1.55.0-noble
PROFILE=$APP/.verify/profile
MARKER="fresh-$(date +%s)"

mkdir -p "$PROFILE" "$APP/proof"

# The browser runs as root in the image, so the profile it leaves behind is
# root-owned and the host user cannot clear it. Wipe it from inside a container
# instead. It must start empty: a profile carried over from a previous run
# would already hold the cache this run is supposed to prove got filled.
docker run --rm -v "$PROFILE:/profile" "$IMAGE" \
  sh -c 'rm -rf /profile/..?* /profile/.[!.]* /profile/*' >/dev/null 2>&1

# Traefik needs a moment to notice a container appear or disappear; a poll for
# the state we want beats a fixed sleep that is either slow or flaky.
# Traefik flaps for a few seconds either side of a container appearing or
# disappearing, and it will hand out a stale 200 from the container it is about
# to drop. So the state has to hold for several consecutive polls before it
# counts — a single matching response is not evidence of anything.
wait_for() {  # wait_for <want-200|want-down> <seconds>
  local want=$1 secs=$2 code hits=0
  for _ in $(seq 1 "$secs"); do
    code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$URL" || echo 000)
    if { [ "$want" = want-200 ] && [ "$code" = 200 ]; } ||
       { [ "$want" = want-down ] && [ "$code" != 200 ]; }; then
      hits=$((hits + 1))
      [ "$hits" -ge 5 ] && { echo "  origin ${want#want-} and stable ($code)"; return 0; }
    else
      hits=0
    fi
    sleep 1
  done
  echo "  TIMED OUT waiting for $want (last $code)"; return 1
}

run() {  # run <phase>
  docker run --rm --ipc=host \
    -e "FRESH_MARKER=$MARKER" \
    -v "$APP/tools:/tools:ro" \
    -v "$APP/.verify/node_modules:/node_modules:ro" \
    -v "$APP/proof:/proof" \
    -v "$PROFILE:/profile" \
    "$IMAGE" node /tools/verify-pwa.js "$1" "$URL"
}

restore() {
  echo
  echo "== Restoring the container"
  docker start minesweeper-web-1 >/dev/null 2>&1
  wait_for want-200 60 || true
  # Phase 3 writes its marker into the live container's style.css, so take it
  # back out — the container should be byte-identical to its image afterwards.
  docker exec minesweeper-web-1 sh -c \
    "sed -i '/fresh-[0-9]\{10\}/d' /usr/share/nginx/html/style.css" >/dev/null 2>&1
}
trap restore EXIT

echo "== Phase 1/3: prime the profile against the live site"
run online || { echo "PHASE 1 FAILED"; exit 1; }

echo
echo "== Stopping minesweeper-web-1"
docker stop minesweeper-web-1 >/dev/null
wait_for want-down 60 || { echo "server did not go down"; exit 1; }

echo
echo "== Phase 2/3: play the game with no server"
run offline || { echo "PHASE 2 FAILED"; exit 1; }

echo
echo "== Restarting minesweeper-web-1, with a marker appended to style.css"
docker start minesweeper-web-1 >/dev/null
wait_for want-200 60 || { echo "server did not come back"; exit 1; }
# Written into the running container, not the image: this has to be a change
# the browser has never seen, made after the cache was filled.
docker exec minesweeper-web-1 sh -c \
  "echo '/* $MARKER */' >> /usr/share/nginx/html/style.css"

echo
echo "== Phase 3/3: back online, and the deploy is not shadowed by the cache"
run fresh || { echo "PHASE 3 FAILED"; exit 1; }

echo
echo "ALL PHASES PASSED"

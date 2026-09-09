# Minesweeper

Classic Minesweeper, served as static files by nginx. No dependencies, no build step,
no JavaScript framework — three files under `site/` are the whole game.

Live: <https://minesweeper.ichabod-crane.net>

## Rules implemented

- Left-click reveals, right-click flags, long-press flags on touch.
- Left-click on a revealed number whose flag count already matches it chords —
  it clears the remaining covered neighbours. Middle-click does the same.
- **The first click is always safe.** Mines are placed *after* that click, with the
  clicked square and all eight of its neighbours excluded from the pool, so the
  opening click always breaks into a region rather than a lone number.
- Zero-adjacency squares flood-fill outward. Flags stop the flood, as they should.
- Win when every non-mine square is revealed; the remaining mines are auto-flagged.
- Loss reveals every mine and marks wrong flags with ✗.

## Difficulties

| Name | Grid | Mines |
|---|---|---|
| Beginner | 9 × 9 | 10 |
| Intermediate | 16 × 16 | 40 |
| Expert | 30 × 16 | 99 |

## Layout

```
site/index.html   markup
site/style.css    styling
site/app.js       all game logic
nginx.conf        :3000, plus a /healthz endpoint for the container healthcheck
Dockerfile        nginx:1.27-alpine + the static files
compose.yaml      Traefik labels, cpus 0.50, mem_limit 512m
```

## Deploy

Traefik must already be running with the external `ichabod-proxy` network.

```sh
docker compose up -d --build
```

DNS for `*.ichabod-crane.net` is a wildcard A record pointing at the host, so a new
hostname needs no DNS work; Traefik requests the certificate on first request.

## Testing hook

`window.minesweeper` exposes `newGame`, `reveal`, `toggleFlag`, `chord`, `state()`
and `mineAt(i)` so a game can be driven and inspected from the console or a
headless browser without synthesising clicks.

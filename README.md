# ICE RIOT

An original 3-on-3 arcade hockey game for the browser: three skaters plus an AI goalie per side,
turbo, bone-rattling body checks that can shatter the glass, charged slapshots, one-timers, dekes
and "ON FIRE" streaks. Three periods plus sudden-death overtime; no icing, offside or penalties.

One machine runs a small Node server. It runs the game and serves the web page. Friends on
the same [Tailscale](https://tailscale.com) tailnet open a link in their browser and play.
There are no accounts, no installs for players and no npm dependencies.

## Requirements

- **Node.js 20 or newer**, on the host machine only.
- **Tailscale** on every player's device, all signed in to the **same tailnet**. Share the
  host machine with friends from the Tailscale admin console, or invite them to your tailnet.
- A modern desktop browser (Chrome, Edge, Firefox, Safari). Keyboard or gamepad.

## Quick start

On the host:

```sh
npm start                 # or: node server/server.js   (Windows: .\start.ps1)
```

The server prints its URLs:

```
  Local:     http://localhost:8765/
  LAN:       http://192.168.1.20:8765/
  Tailscale: http://100.101.102.103:8765/
             http://my-pc.tail1234.ts.net:8765/
```

Open the Local URL yourself. Send friends the **Tailscale** URL (the 100.x address, or the
MagicDNS name). The first player to join is the host. The host picks the teams, period length
and difficulty, then presses Start. Empty skater slots are played by the AI. Players can drop
into a running game at any time by picking a team.

Options: `--port 9000` (or `PORT=9000`), `--host 127.0.0.1`, `--serve` (see below).
With npm: `npm start -- --port 9000`.

### Private rooms

Add `?room=name` to the URL (for example `http://100.101.102.103:8765/?room=friday`). Each room
is its own lobby and game. Rooms are created on demand and disappear when empty.

### HTTPS with `tailscale serve` (optional)

```sh
npm run serve             # = node server/server.js --serve
```

This binds the game to `127.0.0.1` and runs `tailscale serve --bg <port>`. Friends then use
**https://<your-machine>.<tailnet>.ts.net/**. Tailscale proxies to localhost, so no firewall
rule is needed. You need MagicDNS and HTTPS certificates enabled for your tailnet. The first time,
Tailscale may print a link to enable Serve; open it, approve, and the command finishes.
The server never touches your other serve settings: if `https:443 /` already proxies something
else, it uses `https:8443` instead.

The serve proxy stays configured after the game stops. To turn it off:

```sh
tailscale serve --https=443 off       # (or --https=8443 if that port was used)
tailscale serve status                # check what is being served
```

## Windows firewall

The first time `npm start` runs, Windows asks whether Node.js may accept connections. Allow it
on **Private networks**, or friends cannot connect. If you dismissed the prompt or Tailscale's
network is classified as Public, either:

- use `npm run serve` (no firewall rule needed), or
- run `tools\firewall.ps1` from an elevated PowerShell. It allows the game port only from
  Tailscale addresses (`-Remove` deletes the rule again).

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Skate | WASD / arrow keys | Left stick |
| Shoot (tap = wrist shot, hold = charge a slapshot) / body check without the puck | **J** or **Space** | A |
| One-timer | Shoot while a pass is on its way to you | A |
| Pass / switch to the skater nearest the puck | **K** | X |
| Deke (with puck) / stick check (without) | **L** | B |
| Turbo (turbo + check = big hit) | **Shift** | RB / RT |
| Menu | Esc | Start |
| Mute / fullscreen | M / F | |

## Features

- **3-on-3 + AI goalies**, drop-in/drop-out: empty slots are AI, friends can join mid-game.
- **Animated skater models**: rigged players with team colours, back numbers, varied skin and hair, a
  hockey "flow" with spring-physics hair, and clips for skating, sprinting, shots (wrist, slap,
  one-timer), passes, checks, pokes, dekes, falls, faceoffs and celebrations (goalies stay procedural).
- **Hits & glass**: turbo body checks, glass that shatters, and the occasional **fight** mini-game
  (J jab · L haymaker · K block · Shift dodge; the winner catches fire).
- **Instant goal replay** (any button skips), synthesized **arena music**, crowd and SFX.
- **Name tags over every player**, and a red **fist badge over the tough guys** (checking 6+): only
  they can start fights.
- **Lobby chat** + in-game quick chat (Enter/T to type, 1-8 quick lines).
- **Couch co-op**: extra controllers on the same PC press START to join as their own player.
- **Touch controls** for phones/tablets on the tailnet (appear on first touch).
- **Offline practice** vs AI, runs entirely in the browser (also kicks in if the server is unreachable).
- **Challenges**, **settings** (volumes, key rebinding, camera shake…), contextual **tutorial hints**,
  and a persistent **leaderboard** (`data/stats.json` on the host, `/api/leaderboard`).

## Hosting

Players connect over Tailscale; the game is never public. On Windows, run
`powershell -ExecutionPolicy Bypass -File tools\setup.ps1` for a checklist and the URLs to share,
then either `npm start` (after `tools\firewall.ps1` in an admin terminal) or `npm run serve`
(Tailscale Serve, https, no firewall change). `tools\ice-riot.cmd` is a double-click launcher.
Linux (systemd), Docker with a Tailscale sidecar, ACLs, node sharing and troubleshooting:
see [docs/HOSTING.md](docs/HOSTING.md).

## Tips

- Turbo drains fast. Save it for breakaways and big hits.
- A turbo check near the boards can **shatter the glass**. The panels come back at the next faceoff.
- String together goals and big plays and your skater catches **ON FIRE**: flames, and a much
  more dangerous player while it lasts.
- A pass followed by an instant shot (one-timer) beats goalies far more often than a lone wrister.
- A well-timed deke slips past a stick check.

## Troubleshooting

- **Friends can't connect:** check that both of you are on the same tailnet (`tailscale status`
  lists the host), that you sent the 100.x / MagicDNS URL and not `localhost`, and that the
  Windows firewall allowed Node (see above). `tailscale ping <host>` tests the path.
- **"Tailscale: not available" in the banner:** run `tailscale up` (or connect in the Tailscale
  app), then restart the server. The game still works on the LAN URL.
- **Port already in use:** another copy is running; stop it or use `--port 8766`.
- **`npm run serve` fails:** read the `[tailscale]` lines it prints. Usually Serve or HTTPS
  certificates are not enabled for the tailnet yet. `npm start` plus the 100.x URL always works.
- **Choppy play:** prefer a wired or 5 GHz connection on the host. `tailscale status` shows
  whether a peer is connected directly or through a relay (relays add latency).

## Development

```sh
npm test                                   # all unit/integration suites (~30 s)
npm run test:all                           # + lag-proxy suite and the headless-browser end-to-end test
node test/e2e.js                           # real server + bots + headless Vivaldi (env BROWSER=path to override)
node test/bots.js --url ws://127.0.0.1:8765/ws --bots 5 --start   # bot swarm against a running server
node test/netem-proxy.js --listen 9000 --target 127.0.0.1:8765 --profile derp   # simulate a slow tailnet path
node server/server.js --sim test/fake-sim.js   # run the server without the real sim
```

Skater models: `public/models/skater.glb` (+ `skater.physics.json` for the hair) is built in Múcaro by
`blenderremake/testingmcp/hockey/build-game.mjs` with `DETAIL=0.35` (about 61k triangles; `DETAIL=1`
gives the ~400k hero model). `public/render/skater-models.js` drives it from the snapshot; open
`/skaters-test.html` on a running server to see every state's animation side by side. If the model
can't load, the procedural skaters are used.

Layout: `server/` (HTTP + hand-rolled WebSocket + rooms + game loop + Tailscale helper),
`shared/` (constants + the authoritative simulation, also loaded by the browser), `public/`
(client). The network protocol is in `docs/CONTRACT.md`.

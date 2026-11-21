# Hosting ICE RIOT

One machine runs the server (`node server/server.js`, Node >= 20, no npm install). Everyone else
just opens a URL in a browser. Players reach the host over **Tailscale**, so the game is never on
the public internet. Nothing here uses `tailscale funnel`, and nothing should: Funnel makes a
service public.

| Where | How | Friends open | Firewall change |
|---|---|---|---|
| This Windows PC, option A | `npm start` + `tools\firewall.ps1` | `http://<pc>.<tailnet>.ts.net:8765/` | one inbound rule, tailnet addresses only |
| This Windows PC, option B | `npm run serve` (Tailscale Serve) | `https://<pc>.<tailnet>.ts.net/` | none |
| Linux box | `deploy/ice-riot.service` (systemd) | either of the above | usually none |
| Docker | `deploy/docker-compose.yml` (Tailscale sidecar) | `https://ice-riot.<tailnet>.ts.net/` | none |

`<tailnet>.ts.net` is your tailnet's MagicDNS suffix. It is listed on the DNS page of the admin
console, and `tools\setup.ps1` prints the full URLs for you.

## 1. Host on this Windows PC

You need Node 20 or newer, and Tailscale installed and signed in (tray icon > Log in, or `tailscale up`).
Run the checklist first. It only reads and changes nothing:

```powershell
powershell -ExecutionPolicy Bypass -File tools\setup.ps1            # -Port 9000 for another port
powershell -ExecutionPolicy Bypass -File tools\setup.ps1 -Shortcut  # also puts an "ICE RIOT" launcher on the desktop
```

It checks Node, the Tailscale connection state, this PC's tailnet IP and MagicDNS name, whether
the port is free (or ICE RIOT is already running on it), the firewall rules, and the Tailscale
Serve status. It then prints the exact commands and URLs for both options.

`tools\ice-riot.cmd` is a double-click launcher. It runs `node server\server.js` from the repo
root, passes any arguments through (`ice-riot.cmd --serve`, `ice-riot.cmd --port 9000`), and
keeps the window open if the server fails.

### Option A: direct port and a firewall rule

```powershell
# once, in an elevated terminal (Terminal (Admin)); add -WhatIf to preview first
powershell -ExecutionPolicy Bypass -File tools\firewall.ps1          # -Port 9000 / -Remove
npm start                                                            # or double-click tools\ice-riot.cmd
```

`firewall.ps1` creates a single inbound rule named **ICE RIOT (tailnet)**. The rule allows TCP 8765
only from Tailscale addresses (`100.64.0.0/10` and `fd7a:115c:a1e0::/48`) and applies to every
network profile. Running it again changes nothing. Running it with a new `-Port` replaces the
rule, and `-Remove` deletes it. If you run it without admin rights, it prints how to re-run it
elevated.

The first time Node listens, Windows may ask whether to *allow Node.js through the firewall*:

- If you click **Allow**, Windows opens node.exe to your whole LAN for that network type. That
  works, but the scope is wider than you need.
- If you click **Cancel**, Windows creates **block** rules for node.exe. Block rules beat allow
  rules, so friends cannot connect even with the ICE RIOT rule in place. `setup.ps1` detects
  this and prints the command that removes the block rules. Option B is not affected.

### Option B: Tailscale Serve (no firewall change)

```powershell
npm run serve        # = node server/server.js --serve  ->  tailscale serve --bg 8765
```

With `--serve`, the server binds to `127.0.0.1` and Tailscale proxies
`https://<pc>.<tailnet>.ts.net/` to it. Nothing listens on the network, so Windows Firewall plays
no part.

- **Prerequisites:** turn on **MagicDNS** and **HTTPS Certificates** on the admin console's DNS
  page. The first run may print a link that enables Serve for your tailnet. Open the link and the
  command continues.
- **Port 8443:** if another Serve handler already uses port 443, the server uses 8443 instead
  (`https://<pc>.<tailnet>.ts.net:8443/`). The server prints the exact URL.
- **WebSockets:** the page is served over https, and the client switches to `wss://` on https
  automatically.
- **Turning it off:** Serve stays configured after the game stops. Check it with
  `tailscale serve status` and turn it off with `tailscale serve --https=443 off`.
  `tailscale serve reset` also works, but it clears every Serve handler on the machine.

### Sharing the URL with friends

1. Friends install Tailscale and join your tailnet. To invite them, go to the admin console's
   **Users** page and choose **Invite users**.
2. They open the URL that `setup.ps1` or the server printed, in a desktop browser (Chrome, Edge,
   Firefox, or Safari).
   - Members of your tailnet can also use the short name (`http://<pc>:8765/`).
   - The 100.x IP always works: `http://100.x.y.z:8765/`.
3. Running `tailscale status` on their machine should list your PC. If it doesn't, no URL will work.

### If your tailnet uses restrictive access rules

The default policy lets every device reach every other device, so most tailnets need nothing
here. If you have edited the policy (admin console > **Access controls**), allow the game ports
to the host. Get the host IP with `tailscale ip -4`:

```jsonc
{
  "hosts": { "ice-riot-host": "100.x.y.z" },
  "grants": [
    {
      // autogroup:shared = people you shared the machine with (see below)
      "src": ["autogroup:member", "autogroup:shared"],
      "dst": ["ice-riot-host"],
      "ip":  ["tcp:8765", "tcp:443", "tcp:8443"]
    }
  ]
}
```

The same rule in the legacy `acls` syntax is
`{"action": "accept", "src": ["autogroup:member", "autogroup:shared"], "dst": ["ice-riot-host:8765,443,8443"]}`.
For the Docker sidecar, point `dst` at its IP. If you created its auth key with a tag, use that
tag instead (for example `tag:ice-riot`).

### Friends who are not in your tailnet: node sharing

You can share only the host machine with someone who has their own tailnet. They can reach that
one machine and nothing else of yours:

1. In the admin console, open **Machines**, then the host's **...** menu, then **Share**. Send an
   email invite or copy an invite link. Treat the link like a password.
2. The friend accepts the invite while signed in to their own Tailscale account.
3. Shared machines resolve **only by their full name**: `http://<pc>.<tailnet>.ts.net:8765/` (or
   `https://<pc>.<tailnet>.ts.net/` with Serve). The 100.x IP also works.

Shared machines are quarantined: your PC can accept their connections but cannot open
connections to their devices. That is all a game host needs.

## 2. Host on a Linux box (systemd)

On any Linux machine that is on your tailnet:

```sh
sudo useradd --system --home-dir /opt/ice-riot --shell /usr/sbin/nologin iceriot
sudo git clone <repo> /opt/ice-riot            # or copy the folder there
sudo install -d -o iceriot -g iceriot -m 0750 /opt/ice-riot/data   # career stats
sudo cp /opt/ice-riot/deploy/ice-riot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ice-riot
journalctl -u ice-riot -f
```

The unit runs `/usr/bin/node server/server.js` as the unprivileged `iceriot` user with
`PORT=8765` and `Restart=on-failure`, and it is heavily sandboxed. The whole filesystem is
read-only except `data/`. `IPAddressAllow` accepts traffic only from localhost and Tailscale
addresses. Delete the two `IPAddress*` lines if LAN players should connect too.

- If `command -v node` is not `/usr/bin/node`, edit `ExecStart`.
- To change the port, edit `Environment=PORT=`.

Friends open `http://<box>.<tailnet>.ts.net:8765/`. If the box runs a host firewall, open the port
on the Tailscale interface only, for example `sudo ufw allow in on tailscale0 to any port 8765 proto tcp`.
For https, run `sudo tailscale serve --bg 8765` once on the box. It persists across reboots, and
it is allowed because the unit accepts localhost.

## 3. Host in Docker with a Tailscale sidecar

The sidecar joins your tailnet as its own machine, **ice-riot**, and serves the game at
`https://ice-riot.<tailnet>.ts.net/`. No port is published on the Docker host.

1. In the admin console:
   - On the DNS page, enable **MagicDNS** and **HTTPS Certificates**.
   - Under **Settings > Keys**, generate an auth key. Tick *Pre-approved* if device approval is on.
2. From the repo root:

   ```sh
   export TS_AUTHKEY=tskey-auth-...     # or put TS_AUTHKEY=... in deploy/.env (never commit it)
   docker compose -f deploy/docker-compose.yml up -d --build
   docker compose -f deploy/docker-compose.yml logs -f tailscale
   ```

What runs:

- **`tailscale`:** the official `tailscale/tailscale` image in userspace mode, so it needs no
  `/dev/net/tun` or extra capabilities. Its state lives in the `tailscale-state` volume, so the
  key is needed only on first start. It applies `deploy/serve.json`, which proxies port 443 to
  `http://127.0.0.1:8765`. The container fills in `${TS_CERT_DOMAIN}`, and Funnel stays off.
- **`game`:** built from `deploy/Dockerfile` (`node:22-alpine`, non-root `node` user, only
  `server/ shared/ public/ package.json`). It shares the sidecar's network
  (`network_mode: service:tailscale`) and listens on 127.0.0.1:8765. Its filesystem is read-only,
  all capabilities are dropped, and stats are kept in the `ice-riot-data` volume.
- **Day-to-day commands:**
  - Stop: `docker compose -f deploy/docker-compose.yml down`.
  - Forget the machine and the stats: add `-v`. After that, the machine needs a new key.
  - Apply an edit to `serve.json`: `docker compose -f deploy/docker-compose.yml restart tailscale`.
- **Without the sidecar:** run `docker build -f deploy/Dockerfile -t ice-riot .` and then
  `docker run --rm --init -p 8765:8765 ice-riot`. Reach it on the Docker host's port 8765.

## 4. Troubleshooting

**Friends can't connect at all**

1. Run `tailscale status` on both machines. Both must show as connected, and each must see the
   other.
2. From the friend's machine, run `tailscale ping <pc>`.
3. Try the 100.x IP URL. If the IP works but the name doesn't, the problem is DNS (see
   **MagicDNS is off** below).
4. Check that the server is still running and printing logs.
5. Make sure friends use the right port. If you passed `--port`, the URL changes too.
6. On the host, open `http://127.0.0.1:8765/`. If that fails, the problem is the server, not the
   network.

**MagicDNS is off**

`<pc>.<tailnet>.ts.net` does not resolve. Use the 100.x IP, or enable MagicDNS on the admin
console's DNS page. Option B and the Docker sidecar *require* MagicDNS and HTTPS Certificates.

**Windows Firewall (option A)**

1. Run `tools\setup.ps1`. It should report `ICE RIOT (tailnet)` as OK and **no** node.exe block
   rules.
2. If not, run `tools\firewall.ps1` (elevated) and remove the node.exe block rules it reports.
3. Alternatively, switch to option B, which never touches the firewall.

**Port already in use**

Another program, or a second copy of the server, already uses the port. Start the server with
`--port 8766` and pass the same `-Port` to `setup.ps1` and `firewall.ps1`.

**https page, but the game never connects (mixed content)**

The client picks `wss://` on https pages and `ws://` on http pages, so use one consistent URL:

- With Serve, use `https://<pc>.<tailnet>.ts.net/`.
- With option A, use `http://<pc>.<tailnet>.ts.net:8765/`.
- Don't mix the two. For example, `https://...:8765` fails because port 8765 speaks plain http.

**The first https load is slow**

Tailscale issues the certificate on the first request, which can take several seconds.

**`tailscale serve` asks to enable Serve, or says HTTPS is disabled**

Open the link it prints, or enable HTTPS Certificates on the admin console's DNS page, then run
`npm run serve` again.

# codenames-proxy

Serves **codenames.game** through your own domain so it stays playable on a network where the game
is blocked.

The page itself is ordinary reverse-proxying: Caddy terminates TLS and fetches the blocked origin
through a local HTTP proxy. The catch is the game's realtime connection. The client opens a websocket
to `wss://server-discord.gke.codenames.game/...`, a host baked into the JS bundle that the server
also hands out as a `?serverURL=` query parameter. That connection bypasses your proxy, so *Enter
Game* spins forever and no amount of response rewriting fixes it.

This service fixes that one thing: it serves the HTML document with a small inline script at the top
of `<head>` that wraps `window.WebSocket` and swaps that host for your domain.

```
wss://server-discord.gke.codenames.game/0/socket.io/...  ->  wss://your.domain/0/socket.io/...
```

Caddy answers those `/<namespace>/socket.io/` paths with the real game server, through the same
proxy. Because the constructor is patched, every caller is covered — including chunks that are lazily
imported from the CDN after the page loads, which no response rewrite can reach.

Nothing else about the page is touched, and no asset is routed through this service:

| Request | Handled by |
| --- | --- |
| HTML documents | `codenames-proxy`, then the origin |
| `/<n>/socket.io/` websocket | Caddy, straight to the game server |
| everything else (assets, RSC, POSTs) | Caddy, straight to the origin |

## Requirements

- A domain (or subdomain) whose DNS points at the machine running Caddy.
- **Caddy 2.11+** — the site block uses `network_proxy`; the older `proxy` subdirective does not exist.
- **Node 18+** for the service.
- An HTTP proxy that can reach both `codenames.game` and `server-discord.gke.codenames.game`. Both
  hosts were unreachable directly from the test machine, so the proxy is not optional here. The
  default is `http://127.0.0.1:1080`; point it at whatever your tunnel exposes.

## Install

```bash
./install.sh --public-base https://game.example.com
```

That writes `~/.config/systemd/user/codenames-proxy.service` for this checkout and enables it on
the loopback port 8090. Add `--proxy http://127.0.0.1:1080` if your proxy differs, `--port` to move
the local listener, `--after some.service` to order it behind whatever keeps your tunnel up, and
`--uninstall` to remove it again. The user manager must survive logout
(`sudo loginctl enable-linger $USER`); the script warns when it does not.

Then add the site block from [`caddy/site.caddyfile`](caddy/site.caddyfile) to `/etc/caddy/Caddyfile`
(replace `YOUR_DOMAIN`), and reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
```

## Turning it off

```bash
./toggle off      # every page answers 503 until turned back on
./toggle on
./toggle status
```

It is a single flag file (`~/.config/codenames-proxy/disabled`, override with `DISABLE_FLAG`); no
systemd or Caddy involvement. `systemctl --user disable --now codenames-proxy` also works, but then
the subdomain answers 502 instead of a readable page.

## Access control

Anyone who learns the host name can use this deployment to reach the game on your bandwidth. The
site block supports Caddy `basic_auth` (commented in `caddy/site.caddyfile`):

```bash
caddy hash-password --plaintext '<password>'   # put the hash in the basic_auth block
```

Browsers cache the credentials for the origin, so the page's own requests and its websocket carry
them without prompting again.

## Verify a deployment

```bash
# no credentials, with basic_auth enabled
curl -s -o /dev/null -w '%{http_code}\n' https://game.example.com/                       # 401

curl -s -u user:pass -H 'Accept: text/html' https://game.example.com/ | grep -c server-discord   # 0
curl -s -u user:pass -H 'Accept: text/html' https://game.example.com/ | grep -c 'window.WebSocket=W'  # 1

# the socket route answers like the real game server
curl -s -u user:pass -o /dev/null -w '%{http_code}\n' \
  'https://game.example.com/socket.io/?EIO=4&transport=polling'                          # 200
```

`journalctl --user -u codenames-proxy -f` shows upstream failures and the no-`<head>` warning.

## Security notes

- The service listens on loopback only, fetches one fixed host, serves `GET`/`HEAD` only, and never
  takes a target from the caller, so it is not an open proxy.
- No secret lives in this repository; credentials belong in the Caddyfile as a bcrypt hash.

## What did not work

Recorded because the obvious approaches fail in confusing ways:

- **Rewriting the socket host inside the bundle only.** A second copy of that chunk is imported later
  from the CDN and overwrites the patched module, and the server can supply the host as
  `?serverURL=`, so the blocked host comes back.
- **Serving the JS chunks from this origin.** One or two chunks are fine, but serving more — in
  particular the Turbopack runtime chunk, or pointing `TURBOPACK_CHUNK_BASE_PATH` here — silently
  stops the app from booting: no console error, no hydration, just a dead *Enter Game* button.

## Known gaps

- `content-api.codenames.game` (home-page news and the Twitch strip) is fetched directly by the
  browser and fails CORS; it does not affect play.
- Discord login does not round-trip: the Auth.js callback cookie still carries `codenames.game`.
- The shim matches one literal host name. If the site moves its game server, that line needs
  updating.

## License

MIT — see [LICENSE](LICENSE). This is a personal workaround for a blocked site, not an official
client; use it within the site's terms.

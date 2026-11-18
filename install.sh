#!/usr/bin/env bash
# Installs (or removes) the codenames-proxy user service for this checkout.
#
#   ./install.sh --public-base https://game.example.com
#   ./install.sh --uninstall
#
# Options:
#   --public-base URL   required; public address the service is reached on
#   --port N            listen port for the local reverse proxy (default 8090)
#   --proxy URL         HTTP proxy used to reach the blocked site (default http://127.0.0.1:1080)
#   --after UNIT        add a systemd After= dependency, e.g. the unit that keeps the proxy up
#   --uninstall         stop and remove the unit
set -euo pipefail

PUBLIC_BASE=""
PORT=8090
PROXY=http://127.0.0.1:1080
AFTER=""
UNINSTALL=0

die() {
	echo "install.sh: $*" >&2
	exit 1
}

while [ $# -gt 0 ]; do
	case "$1" in
		--public-base) PUBLIC_BASE="${2:-}"; shift 2 ;;
		--port) PORT="${2:-}"; shift 2 ;;
		--proxy) PROXY="${2:-}"; shift 2 ;;
		--after) AFTER="${2:-}"; shift 2 ;;
		--uninstall) UNINSTALL=1; shift ;;
		-h | --help)
			sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*) die "unknown argument: $1" ;;
	esac
done

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit="$unit_dir/codenames-proxy.service"

if [ "$UNINSTALL" = 1 ]; then
	systemctl --user disable --now codenames-proxy.service 2>/dev/null || true
	rm -f "$unit"
	systemctl --user daemon-reload
	echo "removed codenames-proxy.service (the Caddy site block is left untouched)"
	exit 0
fi

[ -n "$PUBLIC_BASE" ] || die "--public-base is required, e.g. --public-base https://game.example.com"
command -v node >/dev/null || die "node is not in PATH"
node_bin="$(command -v node)"
root="$(cd "$(dirname "$0")" && pwd)"
after_line=""
[ -n "$AFTER" ] && after_line=" $AFTER"

mkdir -p "$unit_dir" "${XDG_CONFIG_HOME:-$HOME/.config}/codenames-proxy"

cat >"$unit" <<EOF
[Unit]
Description=codenames-proxy — serves codenames.game with the websocket host pointed at $PUBLIC_BASE
After=network.target$after_line

[Service]
Type=simple
Environment=PUBLIC_BASE=$PUBLIC_BASE
Environment=LISTEN_PORT=$PORT
Environment=UPSTREAM_PROXY_URL=$PROXY
Environment="PATH=$(dirname "$node_bin"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart=$node_bin $root/rewrite.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=codenames-proxy

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now codenames-proxy.service
sleep 2
systemctl --user is-active codenames-proxy.service >/dev/null || die "service failed to start: journalctl --user -u codenames-proxy"

echo "service: $(systemctl --user is-active codenames-proxy.service) (listening on 127.0.0.1:$PORT)"
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
	echo "warning: user lingering is off, so the service stops when your session ends:" >&2
	echo "         sudo loginctl enable-linger $USER" >&2
fi
echo
echo "next: add the site block from caddy/site.caddyfile to your Caddyfile, then"
echo "      sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy"
echo "toggle it off/on any time with: $root/toggle off|on|status"

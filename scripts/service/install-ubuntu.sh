#!/usr/bin/env bash
set -euo pipefail

service_host="${CODEX_TASK_SERVICE_HOST:-0.0.0.0}"
service_port="${CODEX_TASK_SERVICE_PORT:-7777}"
service_concurrency="${CODEX_TASK_SERVICE_CONCURRENCY:-2}"
service_proxy="${CODEX_TASK_SERVICE_PROXY:-${CODEX_TASK_PROXY:-${CODEXERRAND_PROXY:-auto}}}"
service_dir="${XDG_CONFIG_HOME:-$HOME/.config}/codex-task/service"
user_unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
token_file="$service_dir/token"
runner="$service_dir/run.sh"
unit_file="$user_unit_dir/codex-task.service"

command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "systemd user services are required" >&2; exit 1; }

if [[ "${CODEX_TASK_SKIP_GLOBAL_INSTALL:-0}" != "1" ]]; then
  npm install -g codex-task@latest
fi
codex_task_bin="$(command -v codex-task)"

mkdir -p "$service_dir" "$user_unit_dir"
chmod 700 "$service_dir"
if [[ ! -s "$token_file" ]]; then
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' > "$token_file"
fi
chmod 600 "$token_file"

quoted_path="$(printf '%q' "$PATH")"
quoted_bin="$(printf '%q' "$codex_task_bin")"
quoted_host="$(printf '%q' "$service_host")"
quoted_port="$(printf '%q' "$service_port")"
quoted_token="$(printf '%q' "$token_file")"
quoted_concurrency="$(printf '%q' "$service_concurrency")"
quoted_proxy="$(printf '%q' "$service_proxy")"
proxy_export="export CODEX_TASK_PROXY=$quoted_proxy"
cat > "$runner" <<EOF
#!/usr/bin/env bash
export PATH=$quoted_path
$proxy_export
exec $quoted_bin serve --host $quoted_host --port $quoted_port --token-file $quoted_token --max-concurrency $quoted_concurrency
EOF
chmod 700 "$runner"

cat > "$unit_file" <<EOF
[Unit]
Description=CodexTask authenticated HTTP service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="$runner"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now codex-task.service

echo "CodexTask service installed."
echo "URL: http://$service_host:$service_port"
echo "Token: $(<"$token_file")"
echo "Token file: $token_file"
echo "Status: systemctl --user status codex-task.service"
echo "For boot-time start before login, an administrator may run: loginctl enable-linger $USER"
case "$service_proxy" in
  auto|AUTO) echo "Proxy: automatic environment/system detection." ;;
  direct|DIRECT|none|NONE|off|OFF) echo "Proxy: disabled; Direct requests connect directly." ;;
  *) echo "Proxy: fixed URL stored in the protected service runner." ;;
esac

#!/usr/bin/env bash
set -euo pipefail

service_host="${CODEX_TASK_SERVICE_HOST:-0.0.0.0}"
service_port="${CODEX_TASK_SERVICE_PORT:-7777}"
service_concurrency="${CODEX_TASK_SERVICE_CONCURRENCY:-2}"
service_proxy="${CODEX_TASK_SERVICE_PROXY:-${CODEX_TASK_PROXY:-${CODEXERRAND_PROXY:-auto}}}"
service_dir="$HOME/Library/Application Support/codex-task/service"
token_file="$service_dir/token"
runner="$service_dir/run.sh"
log_file="$service_dir/service.log"
label="com.wangyendt.codex-task"
plist="$HOME/Library/LaunchAgents/$label.plist"

command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 1; }
if [[ "${CODEX_TASK_SKIP_GLOBAL_INSTALL:-0}" != "1" ]]; then
  npm install -g codex-task@latest
fi
codex_task_bin="$(command -v codex-task)"

mkdir -p "$service_dir" "$HOME/Library/LaunchAgents"
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

xml_escape() {
  printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/'"'"'/\&apos;/g'
}

cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>$(xml_escape "$runner")</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml_escape "$log_file")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$log_file")</string>
</dict>
</plist>
EOF
plutil -lint "$plist" >/dev/null

launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
bootstrap_status=1
for delay in 0.2 0.5 1; do
  if launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null; then
    bootstrap_status=0
    break
  fi
  sleep "$delay"
done
if [[ "$bootstrap_status" -ne 0 ]]; then
  launchctl bootstrap "gui/$(id -u)" "$plist"
fi

echo "CodexTask LaunchAgent installed."
echo "URL: http://$service_host:$service_port"
echo "Token: $(<"$token_file")"
echo "Token file: $token_file"
echo "Log: $log_file"
case "$service_proxy" in
  auto|AUTO) echo "Proxy: automatic environment/system detection." ;;
  direct|DIRECT|none|NONE|off|OFF) echo "Proxy: disabled; Direct requests connect directly." ;;
  *) echo "Proxy: fixed URL stored in the protected service runner." ;;
esac

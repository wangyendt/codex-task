#!/usr/bin/env bash
set -euo pipefail

service_host="${CODEX_TASK_SERVICE_HOST:-0.0.0.0}"
service_port="${CODEX_TASK_SERVICE_PORT:-7777}"
service_concurrency="${CODEX_TASK_SERVICE_CONCURRENCY:-2}"
service_proxy="${CODEX_TASK_PROXY:-${CODEXERRAND_PROXY:-${ALL_PROXY:-${all_proxy:-${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}}}}}}"
service_dir="$HOME/Library/Application Support/codex-task/service"
token_file="$service_dir/token"
runner="$service_dir/run.sh"
log_file="$service_dir/service.log"
label="com.wangyendt.codex-task"
plist="$HOME/Library/LaunchAgents/$label.plist"

command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 1; }
npm install -g codex-task@latest
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
proxy_export=""
if [[ -n "$service_proxy" ]]; then
  quoted_proxy="$(printf '%q' "$service_proxy")"
  proxy_export="export CODEX_TASK_PROXY=$quoted_proxy"
fi
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
launchctl bootstrap "gui/$(id -u)" "$plist"

echo "CodexTask LaunchAgent installed."
echo "URL: http://$service_host:$service_port"
echo "Token: $(<"$token_file")"
echo "Token file: $token_file"
echo "Log: $log_file"
if [[ -n "$service_proxy" ]]; then
  echo "Proxy: captured in the protected service runner."
fi

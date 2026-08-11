#!/usr/bin/env bash
set -euo pipefail

service_dir="${XDG_CONFIG_HOME:-$HOME/.config}/codex-task/service"
unit_file="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/codex-task.service"

systemctl --user disable --now codex-task.service 2>/dev/null || true
rm -f "$unit_file"
systemctl --user daemon-reload
rm -rf "$service_dir"

echo "CodexTask systemd user service removed. The global npm package and Codex data were preserved."

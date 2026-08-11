#!/usr/bin/env bash
set -euo pipefail

label="com.wangyendt.codex-task"
plist="$HOME/Library/LaunchAgents/$label.plist"
service_dir="$HOME/Library/Application Support/codex-task/service"

launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
rm -f "$plist"
rm -rf "$service_dir"

echo "CodexTask LaunchAgent removed. The global npm package and Codex data were preserved."

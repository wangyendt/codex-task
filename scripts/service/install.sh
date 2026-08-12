#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Install the CodexTask auto-start service for Ubuntu/Linux or macOS."
  echo "Usage: bash scripts/service/install.sh"
  echo "Optional: set CODEX_TASK_PROXY, ALL_PROXY, or HTTPS_PROXY before installation."
  exit 0
fi
if [[ $# -ne 0 ]]; then
  echo "Usage: bash scripts/service/install.sh" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$(uname -s)" in
  Darwin) exec bash "$script_dir/install-macos.sh" ;;
  Linux) exec bash "$script_dir/install-ubuntu.sh" ;;
  *)
    echo "Unsupported platform. This installer supports Ubuntu/Linux and macOS; use Install-Windows.ps1 on Windows." >&2
    exit 1
    ;;
esac

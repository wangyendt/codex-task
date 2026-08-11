#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Uninstall the CodexTask auto-start service for Ubuntu/Linux or macOS."
  echo "Usage: bash scripts/service/uninstall.sh"
  exit 0
fi
if [[ $# -ne 0 ]]; then
  echo "Usage: bash scripts/service/uninstall.sh" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$(uname -s)" in
  Darwin) exec bash "$script_dir/uninstall-macos.sh" ;;
  Linux) exec bash "$script_dir/uninstall-ubuntu.sh" ;;
  *)
    echo "Unsupported platform. This uninstaller supports Ubuntu/Linux and macOS; use Uninstall-Windows.ps1 on Windows." >&2
    exit 1
    ;;
esac

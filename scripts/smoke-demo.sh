#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

run_step() {
    local label="$1"
    shift

    printf '\n==> %s\n' "$label"
    "$@"
}

run_step "Validate env contract" npm run validate:env
run_step "Validate phase 3 provider surface" npm run validate:phase3-surface
run_step "Validate workflow manifest" npm run validate:workflows
run_step "Validate telemetry contract" npm run validate:telemetry

printf '\nDemo smoke validation passed. Run the manual carrier-call checklist before any live prospect demo.\n'

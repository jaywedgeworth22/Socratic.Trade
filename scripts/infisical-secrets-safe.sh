#!/usr/bin/env bash
# Safe Infisical helpers for agents — NEVER dumps secret values to stdout/stderr.
#
# Usage:
#   bash scripts/infisical-secrets-safe.sh set KEY=VALUE --projectId ID --env prod
#   bash scripts/infisical-secrets-safe.sh has KEY --projectId ID --env prod
#   bash scripts/infisical-secrets-safe.sh names --projectId ID --env prod
#
# Forbidden (agents must not run these):
#   infisical secrets                 # bare list prints every value
#   infisical secrets get KEY --plain # without piping to wc/redaction
#   infisical secrets --output json|yaml|dotenv

set -euo pipefail

die() { echo "infisical-secrets-safe: ERROR: $*" >&2; exit 1; }
info() { echo "infisical-secrets-safe: $*" >&2; }

command -v infisical >/dev/null 2>&1 || die "infisical CLI not found"

cmd="${1:-}"; shift || true
[ -n "$cmd" ] || die "missing command (set|has|names)"

# Reject known-leaky patterns if someone passes them by mistake
for a in "$@"; do
  case "$a" in
    --plain|--output=*|json|yaml|dotenv)
      # allow --plain only for has (we consume it ourselves)
      if [ "$cmd" != "has" ] || [ "$a" != "--plain" ]; then
        if [ "$a" = "--plain" ] && [ "$cmd" = "has" ]; then
          :
        elif [[ "$a" == --output* ]] || [ "$a" = "json" ] || [ "$a" = "yaml" ] || [ "$a" = "dotenv" ]; then
          die "refusing $a — dumps secret values. Use set/has/names only."
        fi
      fi
      ;;
  esac
done

case "$cmd" in
  set)
    pair="${1:-}"; shift || true
    [ -n "$pair" ] || die "usage: set KEY=VALUE --projectId ID --env ENV"
    case "$pair" in
      *=*) ;;
      *) die "set argument must be KEY=VALUE" ;;
    esac
    key="${pair%%=*}"
    # never echo value
    infisical secrets set "$pair" "$@" >/dev/null
    info "set ok key=$key"
    ;;
  has)
    key="${1:-}"; shift || true
    [ -n "$key" ] || die "usage: has KEY --projectId ID --env ENV"
    # capture plain value and only print length
    val="$(infisical secrets get "$key" --plain "$@" 2>/dev/null || true)"
    if [ -z "$val" ]; then
      info "missing key=$key"
      exit 1
    fi
    info "present key=$key len=${#val}"
    ;;
  names)
    # List key NAMES only via JSON + jq, never print secretValue
    raw="$(infisical secrets --output json "$@" 2>/dev/null || true)"
    [ -n "$raw" ] || die "names: empty response"
    if command -v jq >/dev/null 2>&1; then
      # Coolify/Infisical shapes vary; try common paths
      echo "$raw" | jq -r '
        if type=="array" then .[]
        elif .secrets then .secrets[]
        else empty end
        | (.secretKey // .key // .name // empty)
      ' | sort -u
    else
      die "jq required for names"
    fi
    ;;
  *)
    die "unknown command: $cmd"
    ;;
esac

#!/bin/sh
set -eu

install_rigup() {
  umask 077
  installer=$(mktemp "${TMPDIR:-/tmp}/rigup-release-installer.XXXXXX")
  trap 'rm -f -- "$installer"' 0
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # Advance this URL after verifying the next public release.
  curl -q -fsSL --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 20 --max-time 60 \
    --output "$installer" https://github.com/ansonli-dev/rigup/releases/download/v0.4.0/install.sh
  /bin/sh "$installer" </dev/null
}

# A streamed copy defines the whole function before doing any work.
install_rigup

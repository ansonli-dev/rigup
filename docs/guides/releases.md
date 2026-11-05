# Install Rigup

Use the [v0.1.0 release](https://github.com/ansonli-dev/rigup/releases/tag/v0.1.0) on macOS or Linux (ARM64 or x64). The portable archive includes Node.js. Keep Git and standard POSIX tools, including `ps`, on PATH. Linux needs glibc 2.35 or later. macOS launchers are ad-hoc signed. Windows users can run the Linux build inside WSL2. See the [platform checks](../compatibility/status.md) and [Windows handoff](external-validation-handoff.md).

```sh
curl -fL --proto '=https' -o rigup-install.sh https://github.com/ansonli-dev/rigup/releases/download/v0.1.0/install.sh &&
  sh rigup-install.sh
export PATH="$HOME/.local/bin:$PATH"
rigup --version
```

The installer checks the archive checksum and links `rigup` into `~/.local/bin`. Then run `rigup init` from the project directory. Semantic research requires a configured backend. Installed MCP runners, hooks, and CI scripts use Node on the consuming environment's PATH. Supply Node.js 24 or add the retained bundle's `lib/node/bin` to that environment. See the [usage reference](usage.md).

## Manual download

Choose `rigup-0.1.0-<target>.tar.gz` and `SHA256SUMS` from the same release. Use `darwin-arm64` for Apple Silicon, `darwin-x64` for Intel Mac, and `linux-arm64` or `linux-x64` for Linux. Check `uname -m` if unsure.

```sh
archive=rigup-0.1.0-darwin-arm64.tar.gz
awk -v name="$archive" '$2 == name {print; found++} END {if (found != 1) exit 1}' SHA256SUMS > "$archive.sha256" &&
  shasum -a 256 -c "$archive.sha256" &&
  tar -xzf "$archive" &&
  export PATH="$PWD/${archive%.tar.gz}:$PATH" &&
  rigup --version
```

On Linux, `sha256sum -c` also works. Keep the complete extracted directory with `lib`, `BUILD_INFO.json`, and its licenses. [Third-party notices](../../THIRD_PARTY_NOTICES.md)

## Upgrade, roll back, or remove

Run the installer for the desired release. It switches the managed link and keeps other versions under `~/.local/share/rigup/versions/`. Use the same absolute `RIGUP_INSTALL_DIR` and `RIGUP_BIN_DIR` when switching versions in a custom location.

If installation stops at an occupied lock, compare the PID and start time in `.install-lock/owner` with `LC_ALL=C ps -p PID -o lstart=`. Remove the owner file and empty lock directory only after verifying that installer exited. An unrelated `rigup` command can use a separate bin directory. Inspect modified version directories before retrying.

Before removing a version, resolve pending operations with the original executable and check that installed tools can still find Node. For the default install, inspect `readlink "$HOME/.local/bin/rigup"` and remove the link if it points to your Rigup installation. Remove unused version directories separately. Keep project manifests and recovery state. [Project recovery](usage.md#应用与恢复)

## Install with Node or build from source

```sh
npm install -g --ignore-scripts https://github.com/ansonli-dev/rigup/releases/download/v0.1.0/rigup-0.1.0.tgz
```

The compiled tarball uses your Node.js 24+ runtime and resolves dependencies from npm. Developers can also run `npm ci`, `npm run build`, and `npm link` from a source checkout. Keep the linked checkout available. [Development guide](development.md)

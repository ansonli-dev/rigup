# Install Rigup

## npm

With Node.js 24 or later, install or upgrade from the public registry. [npm package](https://www.npmjs.com/package/@ansonli.dev/rigup)

On native Windows, run the npm commands in PowerShell 7 with Windows Node.js 24 and Git for Windows on PATH. [Verified platform scope](../compatibility/status.md)

```sh
npm install -g @ansonli.dev/rigup
rigup --version
```

To pin or roll back the CLI, install a specific version such as `npm install -g @ansonli.dev/rigup@0.2.4`. To remove the CLI, run `npm uninstall -g @ansonli.dev/rigup`.

If the original v0.1.0 GitHub `.tgz` is installed in the same npm prefix, run `npm uninstall -g rigup` there before installing the scoped package. The GitHub archive is also available as a direct download for Node.js users.

```sh
npm install -g --ignore-scripts https://github.com/ansonli-dev/rigup/releases/download/v0.2.4/rigup-0.2.4.tgz
```

## Portable installer

Use the v0.2.4 release on macOS or Linux (ARM64 or x64). The portable archive includes Node.js. Keep Git and standard POSIX tools, including `ps`, on PATH. Linux needs glibc 2.35 or later. macOS launchers are ad-hoc signed. Windows users can run the Linux build inside WSL2. [Release downloads](https://github.com/ansonli-dev/rigup/releases/tag/v0.2.4) · [Platform checks](../compatibility/status.md) · [Windows handoff](external-validation-handoff.md)

```sh
curl -fsSL --proto '=https' https://raw.githubusercontent.com/ansonli-dev/rigup/main/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
rigup --version
```

The public entry point downloads a versioned installer. That installer checks the archive checksum and links `rigup` into `~/.local/bin`. Use the versioned installer to pin this release or inspect it before running. [v0.2.4 installer](https://github.com/ansonli-dev/rigup/releases/download/v0.2.4/install.sh) · [Entry point source](https://github.com/ansonli-dev/rigup/blob/main/install.sh)

Run `rigup init` from your project directory. Semantic research requires a configured backend. Automatic OpenSpec setup uses Node.js 22.12 or later and npm from your terminal's PATH. After setup, use the runtimes required by the project and its selected native tools. See the [usage reference](usage.md).

## Manual download

Choose `rigup-0.2.4-<target>.tar.gz` and `SHA256SUMS` from the same release. Use `darwin-arm64` for Apple Silicon, `darwin-x64` for Intel Mac, and `linux-arm64` or `linux-x64` for Linux. Check `uname -m` if unsure.

```sh
archive=rigup-0.2.4-darwin-arm64.tar.gz
awk -v name="$archive" '$2 == name {print; found++} END {if (found != 1) exit 1}' SHA256SUMS > "$archive.sha256" &&
  shasum -a 256 -c "$archive.sha256" &&
  tar -xzf "$archive" &&
  export PATH="$PWD/${archive%.tar.gz}:$PATH" &&
  rigup --version
```

On Linux, `sha256sum -c` also works. Keep the complete extracted directory with `lib`, `BUILD_INFO.json`, and its licenses. [Third-party notices](../../THIRD_PARTY_NOTICES.md)

## Manage a portable install

Run the installer for the desired release. It switches the managed link and keeps other versions under `~/.local/share/rigup/versions/`. Use the same absolute `RIGUP_INSTALL_DIR` and `RIGUP_BIN_DIR` when switching versions in a custom location.

If installation stops at an occupied lock, compare the PID and start time in `.install-lock/owner` with `LC_ALL=C ps -p PID -o lstart=`. Remove the owner file and empty lock directory only after verifying that installer exited. An unrelated `rigup` command can use a separate bin directory. Inspect modified version directories before retrying.

Before removing a version, resolve pending operations with the original executable and check that installed tools can still find Node. For the default install, inspect `readlink "$HOME/.local/bin/rigup"` and remove the link if it points to your Rigup installation. Remove unused version directories separately. Keep project manifests and recovery state. [Project recovery](usage.md#应用与恢复)

## Build from source

Run `npm ci`, `npm run build`, and `npm link` from a source checkout with Node.js 24 or later. Keep the linked checkout available. [Development guide](development.md)

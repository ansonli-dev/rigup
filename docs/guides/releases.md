# Install Rigup

Download a portable archive, installer, or compiled npm tarball from [GitHub Releases](https://github.com/ansonli-dev/rigup/releases). The versioned installer verifies the archive checksum before extraction and places `rigup` in `~/.local/bin` by default. It needs your user's write access and leaves your shell profiles alone.

```sh
curl -fL --proto '=https' -o rigup-install.sh https://github.com/ansonli-dev/rigup/releases/download/v0.1.0/install.sh
sh rigup-install.sh
export PATH="$HOME/.local/bin:$PATH"
cd /path/to/project
rigup init
```

## Manual download

Choose the asset for your OS and architecture. On macOS `uname -m` returns `arm64` or `x86_64`. On Linux it returns `aarch64` or `x86_64`.

- Apple Silicon uses `rigup-0.1.0-darwin-arm64.tar.gz`.
- Intel Mac uses `rigup-0.1.0-darwin-x64.tar.gz`.
- Linux ARM64 uses `rigup-0.1.0-linux-arm64.tar.gz`.
- Linux x64 uses `rigup-0.1.0-linux-x64.tar.gz`.

Save the archive and `SHA256SUMS` from the same release into one directory. In that directory, verify the chosen archive, extract it and add its directory to PATH. Adjust the filename and directory for your target.

```sh
archive=rigup-0.1.0-darwin-arm64.tar.gz
awk -v name="$archive" '$2 == name {print; found++} END {if (found != 1) exit 1}' SHA256SUMS > "$archive.sha256" &&
  shasum -a 256 -c "$archive.sha256" &&
  tar -xzf "$archive" &&
  export PATH="$PWD/${archive%.tar.gz}:$PATH" &&
  rigup --version
```

Linux users can substitute `sha256sum -c` for `shasum -a 256 -c`. The checksum detects corruption and confirms the bytes against the release's published manifest. Verify the download source is the Rigup repository. Keep the entire directory together, including `lib`, `BUILD_INFO.json`, and the license files. If you prefer a single command in `~/.local/bin`, symlink to the extracted `rigup` executable using its absolute path.

## Runtime and platforms

- The portable CLI includes Node.js and locked production dependencies. It needs Git and POSIX utilities, including `ps` (provided by `procps` on minimal Debian/Ubuntu images). The installer also uses curl, tar, and `shasum` or `sha256sum`. Linux builds target glibc 2.35 and newer. The release matrix checks Ubuntu 22.04 and macOS 15. The macOS launcher is ad-hoc signed. Developer ID signing and notarization require separate credentials.
- On Windows, use the matching Linux package inside a glibc-based WSL2 distribution. WSL2 has its own validation checklist. Native Windows has no executable in this release. See the [Windows handoff](external-validation-handoff.md).
- Installed MCP runners, hooks, and CI scripts use the consuming process's Node on PATH. Provide Node.js 24+ in the agent or CI environment. A portable installation can supply it by adding its `lib/node/bin` directory to that environment, for example `export PATH="$HOME/.local/share/rigup/versions/v0.1.0/lib/node/bin:$PATH"`. Projects can also use their own compatible Node independently. Semantic research still requires a configured backend. See the [usage reference](usage.md).
- License and provenance information accompanies each archive in `LICENSE`, `THIRD_PARTY_NOTICES.md`, `BUILD_INFO.json`, `lib/node/LICENSE`, and the production dependencies' own files. See the [distribution notices](../../THIRD_PARTY_NOTICES.md).

## Upgrade, roll back, or remove

Run the installer from the desired release to select that version. Set `RIGUP_INSTALL_DIR` and `RIGUP_BIN_DIR` to absolute paths to use a custom location. Use the same directories for upgrades and rollbacks. The installer keeps each version under `~/.local/share/rigup/versions/` and switches the managed `rigup` symlink only after verification. Re-running an older release's installer selects that version again. Check `rigup --version` after switching.

If an installation stops, inspect `~/.local/share/rigup/.install-lock/owner` for its PID and recorded start time and compare them with `ps -p PID -o lstart=`. An active installer owns that lock. After confirming the owner has exited, remove the stale `owner` file and empty lock directory and retry. An occupied `rigup` path or a modified version directory needs inspection. Use an alternate `RIGUP_BIN_DIR` for an unrelated command, or recover the modified version before retrying.

Pending native operations can refer to the version that created them. Before moving or removing a version, reconcile those operations using its original `rigup` executable. Follow the [protected recovery steps](usage.md) for affected projects. To uninstall the CLI, check `readlink "$HOME/.local/bin/rigup"` and remove the symlink if it points to your Rigup version directory. Remove specific version directories when their operations and runtime consumers are finished. Keep project configuration, manifests, and recovery records for continued use of installed assets.

## Install with Node or build from source

With Node.js 24+ and npm, install the compiled tarball directly from the public release.

```sh
npm install -g --ignore-scripts https://github.com/ansonli-dev/rigup/releases/download/v0.1.0/rigup-0.1.0.tgz
rigup --version
```

This route uses your Node runtime and resolves dependencies from the npm registry. Release downloads are anonymous. The GitHub Packages npm registry uses authentication. Rigup's public distribution uses Releases for both archive formats. See the [GitHub npm registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).

For development, use `npm ci`, `npm run build`, and `npm link` inside a source checkout. Keep the checkout and rebuild after changing source. See the [development guide](development.md).

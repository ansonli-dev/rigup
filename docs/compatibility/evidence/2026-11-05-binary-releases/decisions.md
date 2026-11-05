# Distribution decisions

1. Bundle official Node.js with a native launcher so CLI, workers, and pinned tools use the existing runtime and resource layout. Users download about 57–62 MB per platform and keep the extracted directory together.
2. Serve portable archives and the compiled npm tarball through public Releases. GitHub Packages requires authentication for npm downloads. A separate registry distribution would need its own publishing configuration. [GitHub npm registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)
3. Publish native macOS and Linux targets for ARM64 and x64. Windows users can try the supported Linux distribution inside WSL2. A native Windows artifact needs platform implementation and validation.
4. Installed MCP runners and hooks use Node supplied by the consuming host or CI. Users can supply the bundled runtime on PATH for those consumers, or provision their own Node runtime.
5. Label v0.1.0 a development preview. The installer keeps old version directories available for rollback and native operation recovery. Retention uses disk space and the user chooses the version to install.
6. Test the release distribution independently of WSL2 hosts, other model providers, and native client sessions. Those scenarios need their target environments or provider access. [External handoff](../../../guides/external-validation-handoff.md)
7. Ad-hoc sign the macOS launcher and preserve official Node.js binaries. Developer ID signing and notarization require separate credentials. Managed Mac policy may require those before allowing execution.
8. Require the four-target native matrix and a fresh anonymous install to validate the published bytes. These checks add build and download time and cover platform-specific startup, file integrity, and release availability.

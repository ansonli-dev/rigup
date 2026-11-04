# Open source project preparation references

Reviewed on 2026-11-05. These are organizational references, not claims that Rigup has the same maturity or platform support.

- [Vite README](https://github.com/vitejs/vite/blob/main/README.md): concise project purpose and direct documentation/contribution entry points. Rigup uses a shorter introduction and separate detailed usage reference, with English and Chinese entry points.
- [Vite contributing guide](https://github.com/vitejs/vite/blob/main/CONTRIBUTING.md): explicit tooling, local setup, and repeatable development commands. Rigup provides one `npm run check` gate and documents opt-in integrations separately.
- [GitHub CLI README](https://github.com/cli/cli/blob/trunk/README.md): distinguish installation, documentation, supported platforms, and contribution paths. Rigup states source-only installation and scenario-specific verification instead of implying a registry release or complete compatibility.
- [GitHub Open Source Guide: starting a project](https://opensource.guide/starting-a-project/): make the project's purpose, license, expectations, and contribution path discoverable. Rigup adds licensing, contribution/security guidance, issue/PR templates, and a current support index.
- [MIT license reference](https://choosealicense.com/licenses/mit/): the standard license text and package metadata identifier. Rigup adopts MIT for its own source; optional upstream tools retain their licenses.

No upstream project descriptions or contribution prose were copied. The CI actions are pinned to verified official release commits; the workflow has read-only repository permissions and does not expose credentials or run paid models on pull requests.

# Third-party software

Rigup's source is licensed under the [MIT License](LICENSE). Dependencies retain their own licenses and notices; installing Rigup does not relicense them.

The runtime dependencies are `@anthropic-ai/sdk`, `jsonc-parser`, `node-diff3`, `smol-toml`, and `yaml`. The exact dependency tree is recorded in [package-lock.json](https://github.com/ansonli-dev/rigup/blob/main/package-lock.json); each installed package includes its upstream license. The distribution does not bundle their source into Rigup's JavaScript.

Superpowers, OpenSpec, Spec Kit, OpenWiki, CodeGraph, and the supported coding-agent clients are independent upstream projects. Rigup integrates their native interfaces; it does not redistribute their implementations as its own. Optional tool installation fetches the pinned upstream packages listed in [upstream-lock.json](docs/compatibility/upstream-lock.json), including their licenses. Review those projects' terms before using the integrations.

Public E2E records reference [domain-driven-hexagon](https://github.com/Sairyss/domain-driven-hexagon) and [Bulletproof React](https://github.com/alan2207/bulletproof-react). Their source remains in disposable external checkouts and is not included in the Rigup package.

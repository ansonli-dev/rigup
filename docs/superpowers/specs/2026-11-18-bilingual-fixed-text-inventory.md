# Bilingual fixed-text inventory for Rigup #82

Baseline v0.9.0 (`ee8e29d`). The estimate counts Unicode characters in the English Markdown bodies (including Markdown and preserved examples) and roughly 2,363 characters of renderer literals (excluding dynamic values). Repeated renders across hosts count once. About **28,292 characters** are in scope, below the issue’s roughly 60,000-character review threshold.

| Installed template source under `templates/skills/` | Body characters | Stage 2 |
| --- | ---: | --- |
| `change-prepare/SKILL.md` | 4,106 | Translate body |
| `change-prepare/references/project.md` | 608 | Translate body |
| `change-prepare/references/GOAL.md` | 4,198 | Translate body and preserve the reviewed GOAL structure, arguments, and evidence requirements |
| `change-ready/SKILL.md` | 5,563 | Translate body |
| `change-ready/references/project.md` | 830 | Translate body |
| `change-deliver/SKILL.md` | 8,771 | Translate body |
| `change-deliver/references/project.md` | 1,853 | Translate body |
| **Rendered body total** | **25,929** | |
| Three rendered `SKILL.md` frontmatter blocks | 553 | Preserve `name` and `description` byte for byte for host discovery |
| `change-release/SKILL.md` | 831 including frontmatter | Reserved skill with no render path in v0.9.0 |

Keep relative link destinations, commands, paths, placeholders, environment keys, host names, and skill identifiers stable. References to a localized heading such as **Existing checks** use the same heading text as the assembled project reference.
The GOAL write-scope heading and readiness verdict retain their compatibility spellings for the workflow verification harness.

| v0.9.0 source and output | Characters | Handling and contract |
| --- | ---: | --- |
| `generator/render.ts:51`, OpenSpec command guidance in entries and references | 155 | Translate prose and preserve both commands and their arguments |
| `generator/render.ts:63–64`, installed workflow heading, native phase labels, pending or customer workflow footnote, customer link label | 247 | Translate labels and instructions. Keep native entry names, routes and link destinations |
| `generator/render.ts:66–67`, customer skill and pending project rules instructions in references | 373 | Translate prose and preserve skill and file names |
| `generator/render.ts:69–75`, project rules link and scope instructions in references | 157 | Translate link label and instructions. Keep heading, scope/path lists, and unlabeled source links |
| `generator/render.ts:78–81`, existing checks heading, working directory explanation, trigger label and command lines | 94 | Translate headings and prose. Keep commands, cwd and source paths |
| `generator/render.ts:83–84`, tracker and document routing labels | 41 | Translate labels. Keep serialized keys and values |
| `generator/render.ts:89–96`, managed host entry | 123 | Translate pending rules notice and rules link label. Keep `## Project workflow`, `## Project guidance`, and ownership markers |
| `integrations/sdd/{superpowers,openspec,spec-kit,binding}.ts`, nine native workflow gate sentences copied into project references | 602 | Translate only the rendered sentences. Keep binding values, resolved native names and machine records |
| `generator/harness.ts:96` and `project-conventions.ts:43–52`, fixed fallback convention question | 91 | Translate prose when generated and keep the configured topic title. Preserve YAML keys, status, version and scope used by the convention parser |
| `runtime-inputs.ts:57–99` and `runtime-private-env.ts:129–141`, comments for new `.rigup/.env` entries | 480 | Translate the required/optional labels and the customer command, tracker, registry, and provider instructions. Preserve existing comments, variable names, values and English report reasons |
| `generator/render.ts:112–176,208,266`, convention navigation | 138 for heading and instruction, plus markers | Keep the literal heading, instruction, and token format for `readHarnessRows` and preview validation. Keep titles and scopes from source data. Preserve bare legacy links for migration |
| `generator/project-rules.ts:235–246,282–340`, rule index and topic pages | 0 fixed prose in rendered pages | Planning and acceptance instructions are private. Page headings, instructions, and labels are model- or project-supplied. Keep scoped links, stable IDs and paths |
| `generator/harness.ts:48`, conflict remediation gap | 68 | Preserve the private conflict rationale. Conflicting sources do not produce convention pages or navigation rows |
| `generator/generate.ts`, `generator/document-policy.ts` | 0 fixed prose in rendered pages | Warnings and dispositions are report data. Approval, target, link, and placeholder validation continue to govern generated documents |
| `integrations/registry.ts`, tool and agent adapters, `templates/rigup-mcp.mjs`, GitLab CI and installation YAML | 0 generated workflow prose | Preserve executable wrappers, config keys, environment references and automation diagnostics. Customer templates, skills and source content retain their supplied language |
| `analyzer/prompts.ts`, semantic artifact and rule text | Variable | The existing model language policy applies. The fixed-text renderer uses only `options.documentLanguage`, with English for `auto`, other languages and missing values |

Normal setup saves options in the manifest. Configuration mode also saves the chosen language in `.rigup/config.yaml`. When a hand-written config omits `documentLanguage`, artifact generation retains the existing `loadOptions` profile and installed-default rules. The terminal can use a saved manifest language for its initial display even when the config omits it. Applying a saved preview uses the preview's language and original selection.

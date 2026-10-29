# Third-party notices

## larksuite/openclaw-lark

`vendor/openclaw-lark/card-builder.ts` contains a deliberately small, adapted
subset of the official Lark/Feishu OpenClaw plugin's card builder:

- Repository: <https://github.com/larksuite/openclaw-lark>
- Pinned commit: `dde0be3680d6fd5443cab426c8f4b3216266346a`
- Original: [`src/card/builder.ts`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/card/builder.ts)
- License: MIT; the original license text is in `vendor/openclaw-lark/LICENSE`.
- Source copyright: Copyright (c) 2026 ByteDance Ltd. and/or its affiliates.
- Repository license copyright: Copyright (c) 2026 Lark Technologies Pte. Ltd.

Adaptation retains complete-card Markdown/config/summary construction and the
`toCardKit2` conversion. It removes OpenClaw runtime dependencies, reasoning
panels, tool traces, metrics, and Markdown rewriting. Preview truncation is
Unicode code-point safe. Session navigation, callback routing, and Markdown
chunking in `src/cards.ts` are original bridge code. No full OpenClaw runtime is
bundled or required.

No source from `chenhg5/cc-connect` is included. Its README says MIT, but the
reviewed default branch had no LICENSE file and the GitHub API returned
`license: null`; that mismatch is recorded in `docs/open-source-selection.md`.

Other installed dependencies retain the licenses supplied with their packages.

# only-one-mistake

A local Codex context-evolution companion (scheme A only). It records observable events, problems and evidence-linked memories, then asks the active host to review useful experience at the end of a turn. It does not train model weights or run an independent background model.

[中文](README.md) · [Usage](doc/only-one-mistake.md) · [Architecture](doc/架构.md) · [Validation](doc/验证报告.md)

Node.js 24+ is required. Run `node tools/install-user.mjs install` from this checkout, or `update` for an existing installation, then run `check`. Review and trust hooks through the host CLI `/hooks` and reload the host. File checks alone do not establish live hook execution.

User installation applies to local chats sharing one CODEX_HOME. Memories remain project-scoped. Remote execution hosts, cloud orchestration and other profiles require separate integration. Review consumes the active conversation's quota.

Run `npm ci`, `npm run check` and `npm run package` for development. Packaging produces only `dist/only-one-mistake.zip`, with one companion skill and the A runtime. Internal `evolveflow` names remain for compatibility. Do not enable duplicate plugin/project/user hooks.

Native desktop automatic monitoring and autonomous repair of new failures remain unverified. Evidence from explicit adapters and historical conversations is labelled separately.

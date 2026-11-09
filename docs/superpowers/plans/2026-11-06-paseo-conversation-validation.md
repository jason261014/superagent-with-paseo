# Paseo Conversation Validation

## Automated checks

- `pnpm exec vitest run tests/paseo-executor.spec.ts tests/runtime.spec.ts tests/paseo-ui.spec.ts tests/local-conversation.spec.ts`: 117 tests passed.
- `pnpm check`: typecheck, 68 test files / 1,266 tests, and the provider/application bundles passed.
- `git diff --check`: no whitespace errors.

## Real local loop

The validation used an isolated Paseo daemon at `127.0.0.1:6779` with CLI `0.15.2`; the normal local daemon remained on its own configuration. A real `superagent` session was opened and bound to one local conversation.

The loop covered:

1. A message sent from the Paseo window was admitted by Local Source and routed by the existing coordinator.
2. The worker asked an A/B question through the existing attention and reply flow.
3. A reply in the same Paseo window was attached to the original Ticket; the worker wrote and verified `paseo-ui-result.txt` with `paseo-ui:B`.
4. A second message in the same window created an independent Ticket instead of being appended to the first one.
5. Provider close, reopen and agent reload replayed prior events without duplicate messages.
6. An interruption of the foreground input left an already accepted Ticket running; an explicit stop request ended the selected Ticket with `ended.by = human` and `outcome = stopped`.

The isolated daemon and test processes were stopped after validation. The normal DSH/Paseo configuration was not changed.

## Known limits

- The provider accepts plain text messages only.
- A Paseo UI interrupt cancels the foreground prompt wait. It does not retract a request already accepted by Local Source.
- The provider is an entry point and cannot be selected as the coordinator or worker provider; those roles remain configured with a real model provider.

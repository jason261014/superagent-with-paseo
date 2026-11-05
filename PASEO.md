# Superagent with Paseo

This fork builds on the [DeepSeek Super Agent research prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), retaining its MIT license and attribution. The current milestone validates the smallest possible changes to message entry/output and session execution. Engine, Policy, Ticket, Assignment, Subscriptions, Store, Effects, Outbox, prompts and upstream completion semantics remain in place.

## Current status

The official Runtime now registers a default-closed local Source/Channel. An opt-in Unix socket and CLI submit explicit requests and read persisted replies. The Runtime still uses the original DSH Sessions, DshExecutor and setup, including its configured repository and agent GitHub CLI. Local input does not remove those setup dependencies.

Tests exercise the real Runtime, coordinator tools, worker report tools, Engine and Outbox, with DSH model/session services mocked. They cover acknowledgement, questions, same-thread follow-up, upstream ready → completed, persisted replies, duplicate submissions and restart. This is not a live-model validation claim.

Separately, a dedicated DSH profile completed a real-model A/B question-and-answer task, produced and verified its result file, reported ready and sent the final local reply. Restart preserved replies and a repeated input returned duplicate without creating another ticket. A second task verified the corrected reply record format. The verification process is stopped; see the [run evidence](docs/superpowers/plans/2026-11-05-local-entry-validation.md).

Paseo is **not yet wired** as the coordinator or worker. The existing Paseo client, operation journal, experimental executor and delivery snapshot are earlier foundations. The experimental executor's delivery/acceptance restrictions are not the target for this milestone. The [active plan](docs/superpowers/plans/2026-11-05-superagent-with-paseo-local.md) replaces the [deferred broader plan](docs/superpowers/plans/2026-11-05-superagent-local-future-enhancements.md).

## Local entry

Build with `pnpm build`. In a dedicated DSH profile linked to this checkout, configure the existing plugin:

```yaml
- id: dsh-superagent
  config:
    stateDir: /absolute/private/state
    localRequests: true
- id: dsh-superagent-github
  disabled: true
- id: dsh-superagent-feishu
  disabled: true
```

The last two entries keep external watchers off. Retain the GitHub repository/CLI values required by official setup. In the Superagent management panel, enable **Local requests → Receive local requests**, then add the current OS account (`uid:<id -u>`) to **Policy → Local requests → Allowed local user IDs**. The socket does not bypass that policy. Restart is required when changing `localRequests`; the Source and Policy settings apply live.

```sh
node bin/superagent-local.mjs --state-dir /absolute/private/state status
node bin/superagent-local.mjs --state-dir /absolute/private/state submit \
  --request-id request-1 --thread-id conversation-1 --text 'Investigate the regression'
node bin/superagent-local.mjs --state-dir /absolute/private/state replies --thread-id conversation-1
node bin/superagent-local.mjs --state-dir /absolute/private/state submit \
  --request-id request-2 --thread-id conversation-1 --text 'Use option A'
```

`stored` means the official Engine received the request; it does not mean the coordinator accepted or completed it. Use the same request ID, thread and text when retrying a submission with an uncertain result. Reusing an ID with changed content is rejected. A new request ID in the same thread becomes a follow-up under the original subscription rules. Replies are snapshots; these commands never start a service or watch a conversation.

The socket is `<stateDir>/local-ipc/s`, inside an owner-owned `0700` directory, with socket mode `0600`. Existing unsafe directories, symlinks and non-socket files are rejected. Keep the socket path within 103 UTF-8 bytes for macOS. Runtime holds its existing state lock through socket shutdown and reclaims its stale socket after a crash.

Access means the **same trusted OS account**, including programs running under it; it cannot prove a human typed a request or isolate a hostile worker sharing that account. The operator socket must not be used as an agent report channel or exposed over TCP. A separate constrained tool bridge is required for Paseo.

## Remaining session adaptation

Extract only session creation, delivery, observation, tool/resource/report callbacks and interruption where the actual DSH integration requires it. Preserve the official domain workflow, including ready reports that complete without a PR. Test DSH first, then compare the same scenario on Paseo.

Reuse stable request identities and uncertain-result reconciliation from the existing Paseo adapter. An incomplete lookup remains unknown; idle is neither business completion nor proof all child processes stopped. No verified Paseo queue fence exists yet. Independent delivery storage, an acceptance state machine, generic runtime plugins and broad host restructuring remain deferred.

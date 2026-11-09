# Superagent with Paseo

This fork builds on the [DeepSeek Super Agent research prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), retaining its MIT license and attribution. The current milestone validates the smallest possible changes to message entry/output and session execution. Engine, Policy, Ticket, Assignment, Subscriptions, Store, Effects, Outbox, prompts and upstream completion semantics remain in place.

## Current status

The Paseo plugin now supports managed projects: one provider routes conversations to independent Runtime child processes, with separate state, policy, coordinator bindings and process environments. Processes start on demand and retain explicit running/stopped intent across daemon restarts; closing a conversation does not stop its project. The prepared instance is registered as `legacy`, using its original state and conversation. See [local usage](docs/local-usage.md) and [multi-project validation](docs/superpowers/plans/2026-11-09-paseo-multi-project-runtime-validation.md).

The independent `./paseo-host` ESM export remains the common single-project application. Embedded and external compatibility modes still work, including conversation persistence downgrade/upgrade when rolling back to the same host. DSH remains supported through `src/hosts/dsh.ts`; all paths share the same Engine, Store, effects, local IPC and role-bound MCP bridge.

The earlier single-host milestone verified a question/reply task across plugin reload, recovery after a plugin-process crash, a read-only migration task and a DSH compatibility round trip. These November 8 checks used the real v0.15.2 daemon, desktop result inspection and a separate v0.15.3 daemon restart. See [host validation](docs/superpowers/plans/2026-11-08-paseo-plugin-host-validation.md) for that historical scope.

The official Runtime now registers a default-closed local Source/Channel. An opt-in Unix socket and CLI submit explicit requests and read persisted replies. Without the `paseo` configuration, the Runtime uses the original DSH Sessions and DshExecutor. Both backends retain the original setup, including its configured repository and agent GitHub CLI. Local input does not remove those setup dependencies.

Tests exercise the real Runtime, coordinator tools, worker report tools, Engine and Outbox, with DSH model/session services mocked. They cover acknowledgement, questions, same-thread follow-up, upstream ready → completed, persisted replies, duplicate submissions and restart. This is not a live-model validation claim.

Separately, a dedicated DSH profile completed a real-model A/B question-and-answer task, produced and verified its result file, reported ready and sent the final local reply. Restart preserved replies and a repeated input returned duplicate without creating another ticket. A second task verified the corrected reply record format. The verification process is stopped; see the [run evidence](docs/superpowers/plans/2026-11-05-local-entry-validation.md).

Paseo is now an opt-in coordinator/worker backend. The Runtime keeps the DSH Engine, Policy, Ticket, Assignment, Effects, Outbox and prompt composition, while `PaseoSessions` creates labelled agents and sends stable, journaled messages. A private owner-only MCP bridge exposes the original `orchestrator_*` tools; worker report calls carry a non-claimable ticket/assignment binding and durable receipts replay reports that arrive before launch confirmation. The experimental executor restrictions were removed so `ready` still completes a ticket under the upstream semantics.

In embedded mode configure `hostConfig.paseo` in the plugin's local config, including an explicit `bridgeNode`; the host enables the local socket but still requires the existing Source/Policy settings. In the DSH compatibility path, configure the machine profile with `paseo.url`, `paseo.orchestrator`, `paseo.worker`, their mode IDs, and an absolute `bridgeCommand` pointing to `bin/superagent-mcp.mjs`, and keep `localRequests: true`. The bridge socket carries role-bound model tool calls and reports; the separate operator socket is never a worker report transport.

The Paseo backend has explicit limits: it does not provide DSH's silent history injection, child-job completion evidence, or a queue fence proving that a previously sent message cannot still arrive. Background notices are persisted and attached to the next coordinator message. Interruption records the exact request and fresh runtime observation; an idle observation is not treated as proof that unknown children have stopped.

The existing `ticket/<id>/transcript` and message resources now also read Paseo's public timeline. Messages, combined tool inputs/outputs, errors and compaction markers are projected; reasoning and plugin UI items are omitted. Copy each returned `read` link: its opaque identity binds the agent, timeline epoch and original sequence. Missing bindings, reset/gapped histories, conflicting pages and reads beyond the 20-page bound return an explicit error. The projection is a live view, not an immutable transcript archive or evidence of task completion. Only the currently bound worker session is exposed.

For the prepared local profile and day-to-day commands, see [Local usage](docs/local-usage.md).

## Local entry

For day-to-day embedded use, follow [Local usage](docs/local-usage.md); no DSH process is required. The following describes the retained DSH setup/compatibility path, not an extra daemon to run alongside embedded mode. Build with `pnpm build`. In a dedicated DSH profile linked to this checkout, configure the existing plugin:

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

## Session adaptation

The narrow session port is implemented in `src/paseo/sessions.ts`, the report receipt path in `src/paseo/reports.ts`, and the role-bound MCP bridge in `src/paseo/bridge.ts` / `src/paseo/mcp.ts`. The official DSH path remains intact and still passes its full regression suite.

Reuse stable request identities and uncertain-result reconciliation from the existing Paseo adapter. An incomplete lookup remains unknown; idle is neither business completion nor proof all child processes stopped. No verified Paseo queue fence exists yet. Independent delivery storage, an acceptance state machine, a generic runtime plugin framework and broad domain restructuring remain deferred. Host shutdown uses bounded waiting without prematurely releasing database ownership; uncertain create/send recovery still uses the existing journal.


## Flow canvas

Set `hostConfig.flowWeb = { enabled: true, port: 17890 }` to expose the read-only canvas on `127.0.0.1`. The bearer token and URL live in `<stateDir>/flow-web/access.json` (mode `0600`); open `<url>#token=<token>`. The page projects existing Store records only: it cannot dispatch, retry, cancel, send, or edit Policy, and it starts no LLM calls. Historical report receipts without timestamps show `timestamp not recorded`; create/send intents without a confirmed result show `unconfirmed`; `sent` never means the person read the reply.

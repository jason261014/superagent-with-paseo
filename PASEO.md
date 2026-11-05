# Superagent with Paseo

This fork builds on the [DeepSeek Super Agent research prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), retaining its MIT license and attribution. Its direction is to reuse the prototype's task, event and durable-effect model with Paseo sessions and independently reviewable deliveries.

## Current status

The upstream DSH Runtime remains the only wired execution path. The Paseo session adapter, assignment operation guard and selected-file snapshot are foundations for integration; adding them does **not** make the DSH router or worker run on Paseo. No GitHub or Feishu listener is enabled by these additions.

The intended path is a native CLI and a Paseo coordinator, with explicit targets and frozen task inputs. A task may have multiple assignments and delivery versions. An executor's report, a check against a delivery and the coordinator's decision to accept it are different facts. Existing upstream `ready` behavior is unchanged until the new workflow is wired and validated.

## Integration boundaries

- Keep upstream's transactional Engine and durable effects. Before retrying an uncertain create or send, reconcile its stable identity; an incomplete search must remain unknown.
- The Executor currently relies on its caller to freeze configuration and provide separate, verified workspaces. It does not yet create worktrees or enforce cross-assignment isolation.
- Only accept a worker report after checking its assignment identity inside the same transaction that records it. Delivery, session history and actual model consumption are distinct observations.
- A worker can respond before the initial send is marked running. A future report bridge must durably buffer and replay such reports; it must also associate input IDs with evidence of actual consumption before final reports are enabled.
- A snapshot contains only explicitly selected files and deletions. Persist its returned manifest digest independently. Capture a quiescent trusted workspace: this is neither a filesystem-wide atomic snapshot nor a security sandbox, and it currently does not promise crash durability. Concurrent replacement of a parent directory can evade path checks; do not use it as an isolation boundary against an active or hostile worker.
- Paseo interruption requests must target one verified session. A stopped turn does not prove that every child process exited.
- There is no verified Paseo message-queue barrier yet. After any send, even a currently idle snapshot cannot establish that a delayed message will not wake the session; the experimental Executor leaves its stop effect unresolved.
- Do not silently convert DSH `ready` or passing checks into acceptance. The integration still needs versioned delivery, a review decision and the worker reporting bridge.

Before declaring the path usable, wire an Executor and a reporting bridge into the Runtime, add a native input path, then exercise creation, rework, recovery and stop against an explicitly chosen test environment. Cross-host operation, isolation and source adapters require their own verification.

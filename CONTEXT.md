# CodexTask

CodexTask describes delegated work by the result the caller wants, while allowing every command to receive a composable set of multimodal inputs.

## Language

**Input Part**:
One caller-supplied piece of task context: inline text, a prompt file, standard input, or a local image.
_Avoid_: Prompt source, attachment type

**Text Result**:
A structured task result whose primary deliverable is text.
_Avoid_: T2T, I2T

**Image Artifact**:
A generated PNG returned as a durable or managed temporary artifact.
_Avoid_: T2I result, I2I result

**Workspace Task**:
Delegated work whose primary outcome is inspected or modified files, executed commands, and a concise handoff.
_Avoid_: SDK task, code task

**Workspace Context**:
The directory, project rules, sandbox, network policy, and local tools available to a Workspace Task.
_Avoid_: Current project input

**Resume Turn**:
Additional Input Parts sent to the same paused Workspace Task and Codex thread.
_Avoid_: Resume task

**Managed Temporary Artifact**:
An artifact stored under CodexTask's temporary root and eligible for TTL and capacity cleanup.
_Avoid_: Cache, final output

**Remote Job**:
An asynchronous HTTP submission that tracks one Text Result, Image Artifact, Workspace Task, or Resume Turn from queued state to a terminal result.
_Avoid_: Remote task, queue item

**Service Token**:
A bearer secret accepted by a running CodexTask service. A Master Service Token grants every remote capability; a Scoped Service Token grants Direct `text`, Direct `image`, or both.
_Avoid_: API key, Codex token

**Remote Input Part**:
Inline text, a named UTF-8 prompt document, or a base64-encoded image uploaded in an HTTP request and materialized only for the lifetime of its Remote Job.
_Avoid_: Server path, mobile attachment

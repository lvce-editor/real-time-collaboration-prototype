# Design

## Ownership and convergence

One authoritative session owns a Y.Doc and a fixed list of project text files. Hosts import a browser-selected text folder or use a demo. Each participant receives an unguessable credential separate from the shareable invitation UUID. The server derives identity and role from that credential, never from update payloads. Only a host may grant/revoke write access. A reader's forged updates are rejected before applying any state. Disconnecting never silently grants access. The host remains the host when offline and may reconnect with its saved credential.

Each file is a Y.Text. Concurrent inserts/deletes merge through Yjs CRDT identities; repeated updates are idempotent. Server acceptance validates updates in a disposable document before mutating authority and bounds encoded project state at 2 MB. Reliable WebSocket order defines the permission boundary: updates received before revocation commit; later updates are rejected. No last-writer-wins whole-document replacement is used. Relative cursor and selection positions move through edits, with authoritative participant names/colors attached by the receiving client. Presence is ephemeral; disconnect removes it.

The transport worker isolates connection lifecycle and heartbeats. The UI owns the CRDT binding and emits structured messages. A future adapter must provide reliable ordered delivery or add sequencing/retransmission; merely swapping a WebSocket for unreliable datagrams is insufficient. Document updates and presence are separate protocol messages.

## Recovery and resource bounds

A reconnect replaces the client document with a fresh authoritative snapshot. Offline editing is disabled. Already acknowledged changes survive reconnect; an in-flight change may commit even if its acknowledgement is lost. Unacknowledged/rejected changes are not replayed after reconnect or revocation, and the Output channel reports that they may have been discarded. This prototype does not promise offline editing or persistent sessions. Each credential has one current connection; a replacement invalidates its predecessor without letting the old socket publish additional edits.

The worker times out a silent connection after six seconds and reconnects after 1.5 seconds. Each connection authenticates within five seconds. Payloads, buffered outbound bytes, imported projects, retained session documents, total sessions and participant counts are bounded. Slow consumers disconnect and recover through a snapshot. Sessions with no active connections expire. Participant records remain until session expiry so reconnect can preserve permission and identity; a session therefore caps total identities, not just currently online clients.

Output retains 300 lines. Trace reports message types, cursor/permission metadata and update byte counts, not credentials or document contents. The persisted verbosity setting is local to the browser. The HTTP allowlist blocks LVCE remote-file and shared-process routes, and WebSocket upgrade accepts only `/collaboration`. Origin checks reject cross-origin browser requests. This is a trusted-group prototype, not an internet multi-tenant service: account authentication, invitation rotation, durable storage, per-user quotas, and audit storage remain future work.

## LVCE integration seam

`packages/server/src/server.ts` installs handlers then launches pinned `@lvce-editor/server`. `packages/server/scripts/patch-server.ts` adds two delegation hooks and fails if the expected server source changes. Dependencies are assigned to their owning npm workspaces and pinned in the root lockfile. A clean install and repeated patching are covered in CI. No upstream packages are edited or released.

The prototype loads the complete, pinned LVCE web workbench from `@lvce-editor/static-server`: its title bar, activity bar, Explorer, tabs, editor, status bar, command palette and Output panel. `buildWorkbench` copies that immutable artifact and applies version-checked, unique-anchor patches. The runtime uses LVCE's web platform; remote filesystem RPC and shared-process sockets remain denied. Shared files live in the workbench's browser memory filesystem and native editors retain syntax, input and layout ownership.

Collaboration is builtin for this experiment. The current extension document-edit API is not implemented, so extending that public API is deferred. “Collaboration: Session controls” in the real command palette provides hosting/folder import, joining, invitations, participant approvals/revocation, downloads, verbosity, Output and leaving. Collaboration logs appear as a channel in LVCE's real Output panel, with bounded lines and automatic refresh.

One browser queue serializes local native input, remote authority updates and permission notifications. Both direct DOM input and native keyboard commands enter the same bridge. Collaboration callbacks bypass the ordered renderer render queue to avoid holding it while calling back to render. Editor creation/focus runs outside the collaboration queue; when creation completes, authority is reconciled before the editor becomes writable. The workbench owns editor disposal; capture/sync ignores closed editor IDs, and presence overlays follow each live editor's bounds and native row/column metrics.

A native command produces a splice against its current Y.Text replica; unaffected CRDT items survive. Incoming updates capture native selections as Yjs relative positions, apply the remote update, then refresh each open native editor without emitting a local edit. Remote snapshots clear positional native undo/redo history. Local undo remains available until a remote update; collaborative undo spanning remote updates is outside this prototype. Presence uses participant colors, name labels and initial avatars. Read-only DOM input and bridge checks complement decisive server authorization. Rejected pending edits reconnect to authority and are not replayed.


## Scope and scaling

Projects support editing existing text files, switching files, selecting a folder on session creation, and downloading edited files. Creating/renaming/deleting files, binary assets, terminals, shared debugging, disk synchronization, offline editing, and undo semantics spanning permission revocation are outside this experiment.

The benchmark launches real protocol clients and all presence traffic on loopback. Up to ten writers concurrently insert distinct markers, then verifies every replica against authority with all markers retained. It records setup time, delivery latency p50/p95, delivery throughput, convergence and combined peak RSS. A parent process enforces each capacity deadline; failed levels remain in the report. Large-session join notifications and full member snapshots generate quadratic traffic; broadcasting to every member is also linear per edit. Production scaling would need presence subscriptions/batching and explicit limits, which should be benchmarked as a separate design rather than hidden by omitting presence from this workload.

The server also probes WebSocket liveness every 30 seconds and terminates peers that miss a pong, so abandoned TCP connections cannot retain sessions indefinitely.

## Development transport

`npm run dev` enables one automatically joined session. Allocation is synchronous on the Node server, so the first request receives `user-1` and host authority, with sequential reader identities afterward. Colors use a permutation of the 24-bit RGB space instead of a repeating palette. Page lifetimes own dev credentials in memory; tab cloning and reload never reuse sessionStorage. Network reconnect retains the current page credential. No host election is performed.

The window owns a full mesh of reliable ordered WebRTC channels, while the worker keeps WebSocket authentication, signaling, heartbeat and recovery. Lexicographic participant ID chooses the offerer; SDP contains gathered ICE candidates. Only online members of the authenticated session can receive signaling. Peer teardown follows member departure, authoritative snapshot replacement, connection loss and page unload. Failed negotiation falls back to WebSocket until the next reconnect.

Node signs approved updates and presence using an ephemeral Ed25519 key. The snapshot supplies the public key over the authoritative connection. Receivers verify the signature, session and sender before applying peer payloads; the WebSocket permission boundary therefore remains decisive even after revocation. Already committed edits remain valid and Yjs handles redundant updates idempotently. Cursor sequences reject stale peer duplicates. Peer payloads are capped at 60 kB, outbound buffering at 1 MB and verification queues at 64 messages per peer. WebSocket continues delivering authoritative changes, including large edits, and snapshots repair late joins and reconnects. This intentionally redundant prototype does not reduce server traffic or claim large-mesh scalability.

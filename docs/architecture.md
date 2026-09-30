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

`src/server.js` installs handlers then launches pinned `@lvce-editor/server`. `scripts/patch-server.js` adds two delegation hooks and fails if the expected server source changes. Dependencies and lockfile are pinned. A clean install and repeated patching are covered in CI. No upstream packages are edited or released.

The dedicated view uses CodeMirror for its existing Yjs binding and cursor decorations. It deliberately does not load the ordinary LVCE renderer: doing so would require a permission-aware filesystem/editor bridge before sharing with guests. Native editor integration should keep this server authority and transport seam, replace the view with LVCE editor-worker document/selection adapters, and expose the channel through LVCE's output API. These are explicit follow-up seams, not features supplied by this repository.

## Scope and scaling

Projects support editing existing text files, switching files, selecting a folder on session creation, and downloading edited files. Creating/renaming/deleting files, binary assets, terminals, shared debugging, disk synchronization, offline editing, and undo semantics spanning permission revocation are outside this experiment.

The benchmark launches real protocol clients and all presence traffic on loopback. Up to ten writers concurrently insert distinct markers, then verifies every replica against authority with all markers retained. It records setup time, delivery latency p50/p95, delivery throughput, convergence and combined peak RSS. A parent process enforces each capacity deadline; failed levels remain in the report. Large-session join notifications and full member snapshots generate quadratic traffic; broadcasting to every member is also linear per edit. Production scaling would need presence subscriptions/batching and explicit limits, which should be benchmarked as a separate design rather than hidden by omitting presence from this workload.

The server also probes WebSocket liveness every 30 seconds and terminates peers that miss a pong, so abandoned TCP connections cannot retain sessions indefinitely.

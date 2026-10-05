# 10,000-participant capacity investigation

The failure was reproduced on main commit `343967bf0704` in the invitation-mode, single-project WebSocket/Yjs workload. The server did not run out of connection slots. Join traffic and its processing exhausted the capacity deadline before all participants connected. The development full WebRTC mesh and thousands of complete browser workbenches are different workloads, not validated by this experiment.

## Measurements

The successful main workflow [37235594485](https://github.com/lvce-editor/real-time-collaboration-prototype/actions/runs/37235594485) on Node 26.10, Linux Azure and AMD EPYC 7763 passed 10/100/1,000 clients. At 1,000 it needed 10,401 ms setup. At 10,000 it connected only 2,098 by the 45-second deadline, with 226 MiB combined peak RSS.

Local comparisons used Node 24.15.0 (CI uses the required Node 26), Linux x64, AMD EPYC-Rome, eight virtual CPUs. Each scenario had a 45-second deadline and 768 MiB JS heap per process, real loopback sockets, complete membership traffic, one text file and ten concurrent writers. Separate mode has a server and a load-generator process; combined mode has one process. RSS is not the JS heap limit. The following separate-process comparison uses the same 200-connection ramp and load-generator source on baseline and candidate:

| Measurement | Baseline | Candidate |
| --- | ---: | ---: |
| 1,000-client setup | 7,778 ms | 996 ms |
| 10,000 connected | 2,313 at deadline | 10,000 |
| 10,000-client setup | incomplete | 15,773 ms |
| Edit propagation | not reached | 2,226 ms |
| p50 / p95 delivery latency | not reached | 1,211 / 2,070 ms |
| Delivered updates / second | not reached | 44,912 |
| Server peak RSS | 124.4 MiB at timeout | 264.2 MiB |
| Load-generator peak RSS | 250.4 MiB at timeout | 586.8 MiB |
| Unexpected closes | 0 observed before timeout | 0 |
| Replica convergence | not reached | all replicas, all ten markers |

These are individual measurements, not universal capacity guarantees. Artifacts also contain traffic, server/client CPU, peak heap and event-loop delay. CI repeats the capacity workload and requires it to pass. The original combined-process 20-at-a-time diagnostic is retained in every report, including its observed failed levels. On the local machine it still exceeded 45 seconds at 10,000. Even separate mode with a 20-at-a-time ramp approached the deadline: setup took 42 seconds and subsequent editing missed the deadline. The faster 200-at-a-time ramp amortizes handshake serialization; its selection is explicit, not an assertion that all connection patterns perform equally.

## Causal experiments

1. Serializing each broadcast once, with unchanged frames, barely changed local 1,000-client setup (15.6 to 14.7 seconds). It did not fix 10,000.
2. Ordered join/departure batches improved 1,000-client setup to 2.7 seconds, but 10,000 still timed out.
3. With a separate server and batched notifications, 5,401 clients consumed approximately 3.86 GB of server traffic before timeout. Separation helped but did not remove the join traffic bottleneck.
4. Shared roster serialization and compressed binary presence frames, together with a bounded load-generator decoder cache, allowed the explicit 200-at-a-time separate-process workload to connect all 10,000 and deliver 99,990 updates to convergence. Repeated base64/JSON envelope decoding in one simulated-client process was itself a major load-generator cost; binary frame identities avoid mistaking that cost for server connection capacity.

The load generator shares decoded immutable frames in bounded caches: eight complete rosters and 128 member batches. Every participant still receives the complete payload over its own real socket. Browsers decode independently and do not share this cache. The benchmark therefore measures protocol delivery and CRDT convergence, not 10,000 browser processes or native editor rendering.

## Implementation and remaining bounds

Clients negotiate the batched format. Document snapshots precede complete rosters on their ordered socket. Roster serialization is shared across pending handshakes; membership changes preserve ordering and are sent within 50 ms or at 128 entries. Permission/write-request events flush pending presence first, preventing older join metadata from overwriting a newer role. Legacy clients retain individual JSON events and full snapshots. Slow consumers still close with 1013 and reconnect for authority.

The roster includes current cursors. Previously every browser republished its cursor whenever anyone joined, and each publication was broadcast again to everyone. Late joins now get the server's current cursors directly; they no longer trigger that extra all-to-all traffic. Disconnect removes cached cursors, replacement retains authorization and recovery snapshots retain committed edits. Browser decompression and message handling remain ordered across reconnects.

Complete roster delivery is still quadratic in aggregate bytes across a sequential join ramp. Document/cursor broadcasts are linear per event. Large browser populations, high cursor/edit rates, large imported documents, slow network links and the development WebRTC full mesh need their own measured workloads. This change does not claim 20,000 connections or production capacity. No upstream package release is needed: the prototype is private and its workbench integration uses local version-checked patches.

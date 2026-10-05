# Real-time collaboration prototype

A runnable LVCE server experiment: host a text project, share an invitation URL or UUID, approve read-only guests as writers, and edit together with colored participant cursors. Includes a collaboration output channel with persistent Off/Info/Debug/Trace verbosity, multi-client browser tests, and load benchmarks.

## Run

Requires Node.js 26 and npm. Maintained executable source, tooling, protocol tests, browser tests, and benchmarks use TypeScript. Node.js 26 runs the TypeScript entry points directly with built-in type stripping, and esbuild bundles the browser modules. The JavaScript fixture remains sample project data, and the patch fragment remains JavaScript because it is injected into the pinned upstream editor bundle.

```sh
npm ci
npm run build
npm run typecheck
npm start
```

Open http://127.0.0.1:3000 in separate browser profiles. The complete LVCE IDE loads. Open its command palette (Ctrl/Cmd+Shift+P), keep the `>` command prefix, and choose **Collaboration: Session controls**. Use **Host project** for the demo or **Host folder** to import up to 100 text files / 500 kB. **Copy invitation** copies the shareable URL. Guests choose **Join project** and **Request write access**; the host chooses **Participants**, then a reader to approve or a writer to revoke. The real Explorer opens shared files, while **Show Output** opens LVCE’s Collaboration output channel. Imported line endings are normalized to LF. Download individual edited files using **Download file**. Sessions are in memory and expire 30 minutes after the last participant disconnects; a server restart removes them.

For another machine on a trusted network, run `HOST=0.0.0.0 npm start` and open the host's network address. Use TLS at a reverse proxy for remote use. Invitation holders can read the entire selected project; participant credentials stay in tab session storage. The prototype serves only its own routes, never the underlying LVCE filesystem RPC.

## Try automatic development collaboration

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:3000 in multiple tabs or browsers. This command builds the application and starts one Node.js server, which owns the shared demo session and WebRTC signaling. Each page load gets a fresh `user-N` identity and a distinct color, including duplicated tabs. The first participant is the host; other users start read-only. Use **Collaboration: Session controls → Participants** as host and select a reader to let them edit. Closing the host does not promote another user. Reloading creates a new user; restart the dev server to start a fresh session and host. Temporary network reconnections within a page retain that page's identity and recover a server snapshot.

Browsers establish reliable ordered WebRTC data channels in a mesh. Node authenticates and routes SDP/ICE, validates edits and signs committed edits/cursors before the originating browser relays them to peers. The server also delivers updates over WebSocket for recovery and fallback; this is deliberately redundant prototype transport. Debug output shows peer connections and received WebRTC updates/cursors. Large payloads (over 60 kB), unavailable peers and browsers without WebRTC/secure-context crypto use WebSocket delivery. No STUN/TURN service is configured: this is intended for localhost or a reachable trusted LAN, not NAT traversal across the internet. Remote browsers need HTTPS for signature verification. The regular `npm start` invitation workflow remains available.

## Integration decision

The workbench runs the native LVCE editor and syntax workers, with LVCE input commands, selections and virtual-DOM rendering. Yjs binds native edits to the authoritative session. Local postinstall patches add HTTP/WebSocket hooks to the pinned server and a narrow snapshot/state interface to the pinned editor worker. All patches live in this repository; no upstream checkout or release is required. Collaboration controls use the native command palette and logs use the real Output panel. The build copies the complete pinned workbench and applies guarded prototype patches; no custom IDE shell is rendered.


The npm workspace packages separate collaboration code and protocol tests (`packages/collaboration`), the LVCE server integration (`packages/server`), browser tests (`packages/e2e`), build scripts (`packages/build`), and load benchmarks (`packages/benchmark`). Root scripts keep the common commands available from the repository root.

The workbench bridge serializes input and remote updates and preserves relative selections. LVCE owns editor creation, tabs, file switching and disposal; closing an editor releases its collaboration presence binding. See [architecture and limitations](docs/architecture.md). The transport worker exposes connect/send/disconnect, with WebSocket for authority and recovery. Development sessions additionally use browser-owned WebRTC peer connections; WebTransport remains unimplemented.

## Verification

```sh
npm test
npx playwright install chromium
npm run test:e2e
npm run benchmark
```

CI runs protocol tests on Linux, macOS, and Windows, plus isolated Chromium multi-client e2e tests. `npm ci` reapplies idempotent, fail-closed server and editor patches. Browser tests launch the actual patched LVCE server. The benchmark uses real loopback WebSockets and Yjs documents, not full browser/editor instances. It attempts 10, 100, 1,000 and 10,000 participants with a 45-second deadline per level and 768 MiB JS heap per process. Capacity uses separate server/client processes with a 200-connection ramp; the original combined-process 20-connection ramp remains a diagnostic. Optional positional arguments select levels, e.g. `npm run benchmark -- 10 100`.

`npm run benchmark` writes its JSON results to `benchmark/results.json` in your working tree. That generated file is ignored by Git. To run selected workload sizes, use `npm run benchmark -- 10 100`.

To inspect CI measurements, open the **Protocol benchmarks** workflow run and download its **protocol-benchmarks** artifact. Successful runs on `main` also publish a report to [GitHub Pages](https://lvce-editor.github.io/real-time-collaboration-prototype/); pull request runs make the artifact available without publishing the report.

The benchmark uses real loopback WebSockets and Yjs documents rather than full browser/editor instances. CI requires all 10,000 protocol clients to connect and converge under the separate-process workload, with no unexpected disconnects. It also preserves the original 10/100 combined-process gates and publishes failed diagnostic levels. Full roster traffic remains quadratic; these measurements do not establish browser, WebRTC-mesh, WAN or production capacity. See [the capacity investigation](docs/capacity-investigation.md) for baseline evidence, resource limits and decoder caching.

## Published benchmark report

Successful runs on `main` publish the benchmark report and a browser recording to [GitHub Pages](https://lvce-editor.github.io/real-time-collaboration-prototype/). The report includes the commit and workflow run that produced its downloadable JSON. A failed or capacity-limited benchmark level remains visible with its observed outcome and reason. Pull request runs build and validate the static report without publishing it.

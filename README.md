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

Open http://127.0.0.1:3000 in separate browser profiles. Host a demo project or select a folder (up to 100 text files / 500 kB). Share the displayed invitation. A guest clicks **Request write access**; the host clicks **Allow**. Hosts can revoke access. Imported line endings are normalized to LF. Download individual edited files using **Download file**. Sessions are in memory and expire 30 minutes after the last participant disconnects; a server restart removes them.

For another machine on a trusted network, run `HOST=0.0.0.0 npm start` and open the host's network address. Use TLS at a reverse proxy for remote use. Invitation holders can read the entire selected project; participant credentials stay in tab session storage. The prototype serves only its own routes, never the underlying LVCE filesystem RPC.

## Integration decision

The workbench runs the native LVCE editor and syntax workers, with LVCE input commands, selections and virtual-DOM rendering. Yjs binds native edits to the authoritative session. Local postinstall patches add HTTP/WebSocket hooks to the pinned server and a narrow snapshot/state interface to the pinned editor worker. All patches live in this repository; no upstream checkout or release is required. The collaboration controls and output channel belong to this prototype shell.


The npm workspace packages separate collaboration code and protocol tests (`packages/collaboration`), the LVCE server integration (`packages/server`), browser tests (`packages/e2e`), build scripts (`packages/build`), and load benchmarks (`packages/benchmark`). Root scripts keep the common commands available from the repository root.

The native adapter serializes input and remote updates, preserves relative selections, and disposes editor workers when switching files or reconnecting. See [architecture and limitations](docs/architecture.md). The transport worker exposes connect/send/disconnect, with WebSocket as the working adapter; WebRTC/WebTransport are future adapters, not implemented transports.

## Verification

```sh
npm test
npx playwright install chromium
npm run test:e2e
npm run benchmark
```

CI runs protocol tests on Linux, macOS, and Windows, plus isolated Chromium multi-client e2e tests. `npm ci` reapplies idempotent, fail-closed server and editor patches. Browser tests launch the actual patched LVCE server. The benchmark uses real loopback WebSockets and Yjs documents, not full browser/editor instances. It attempts 10, 100, 1,000 and 10,000 participants with a 45-second deadline and 768 MiB JS heap per level. Optional positional arguments select levels, e.g. `npm run benchmark -- 10 100`.

`npm run benchmark` writes its JSON results to `benchmark/results.json` in your working tree. That generated file is ignored by Git. To run selected workload sizes, use `npm run benchmark -- 10 100`.

To inspect CI measurements, open the **Protocol benchmarks** workflow run and download its **protocol-benchmarks** artifact. Successful runs on `main` also publish a report to [GitHub Pages](https://lvce-editor.github.io/real-time-collaboration-prototype/); pull request runs make the artifact available without publishing the report.

The benchmark uses real loopback WebSockets and Yjs documents rather than full browser/editor instances. Presence join fan-out is quadratic, so this prototype does not claim 10,000-user capacity. Measurements include the server and simulated clients in one process and are not production capacity estimates.

## Published benchmark report

Successful runs on `main` publish the benchmark report and a browser recording to [GitHub Pages](https://lvce-editor.github.io/real-time-collaboration-prototype/). The report includes the commit and workflow run that produced its downloadable JSON. A failed or capacity-limited benchmark level remains visible with its observed outcome and reason. Pull request runs build and validate the static report without publishing it.

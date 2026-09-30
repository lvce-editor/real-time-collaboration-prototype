# Real-time collaboration prototype

A runnable LVCE server experiment: host a text project, share an invitation URL or UUID, approve read-only guests as writers, and edit together with colored participant cursors. Includes a collaboration output channel with persistent Off/Info/Debug/Trace verbosity, multi-client browser tests, and load benchmarks.

## Run

Requires Node.js 24 and npm. Runtime modules are TypeScript; Node.js 24 runs the server directly with built-in type stripping, and esbuild bundles the browser modules.

```sh
npm ci
npm run build
npm run typecheck
npm start
```

Open http://127.0.0.1:3000 in separate browser profiles. Host a demo project or select a folder (up to 100 text files / 500 kB). Share the displayed invitation. A guest clicks **Request write access**; the host clicks **Allow**. Hosts can revoke access. Download individual edited files using **Download file**. Sessions are in memory and expire 30 minutes after the last participant disconnects; a server restart removes them.

For another machine on a trusted network, run `HOST=0.0.0.0 npm start` and open the host's network address. Use TLS at a reverse proxy for remote use. Invitation holders can read the entire selected project; participant credentials stay in tab session storage. The prototype serves only its own routes, never the underlying LVCE filesystem RPC.

## Integration decision

This is a **dedicated collaboration workbench view hosted by `@lvce-editor/server`**, with a transport worker and a CodeMirror/Yjs collaborative editor. It is **not yet an LVCE native-editor extension**. The inspected extension API has no document-change subscription, so pretending an extension alone provided that integration would hide the main design gap. The local postinstall patch installs two HTTP/WebSocket hooks in the pinned server. It does not modify any upstream checkout or expose local files. The output channel and its verbosity setting belong to this prototype view rather than LVCE's native Output panel.

The npm workspace packages separate collaboration code and protocol tests (`packages/collaboration`), the LVCE server integration (`packages/server`), browser tests (`packages/e2e`), build scripts (`packages/build`), and load benchmarks (`packages/benchmark`). Root scripts keep the common commands available from the repository root.

This boundary allows evaluating collaboration semantics before adapting LVCE's editor-worker edit and decoration APIs. See [architecture and limitations](docs/architecture.md). The transport worker exposes connect/send/disconnect, with WebSocket as the working adapter; WebRTC/WebTransport are future adapters, not implemented transports.

## Verification

```sh
npm test
npx playwright install chromium
npm run test:e2e
npm run benchmark
```

CI runs protocol tests on Linux, macOS, and Windows, plus isolated Chromium multi-client e2e tests. `npm ci` reapplies an idempotent, fail-closed server patch. Browser tests launch the actual patched LVCE server. The benchmark uses real loopback WebSockets and Yjs documents, not full browser/editor instances. It attempts 10, 100, 1,000 and 10,000 participants with a 45-second deadline and 768 MiB JS heap per level. Optional positional arguments select levels, e.g. `npm run benchmark -- 10 100`.

See [recorded measurements](docs/benchmark-results.json). The initial 10,000-user attempt hit the setup deadline at 1,803 connected users; this prototype does not claim 10,000-user capacity. Presence join fan-out is quadratic and is the next scaling boundary to investigate. Measurements include the server and simulated clients in one process and are not production capacity estimates.

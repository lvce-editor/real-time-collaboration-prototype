import { cp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { patchEditorSource } from './editor-patch.ts'

export async function buildWorkbench(output: string) {
  const require = createRequire(import.meta.url)
  const root = dirname(require.resolve('@lvce-editor/static-server/package.json'))
  const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
  if (config.version !== '0.118.22' || config.commit !== '56b33a7') throw new Error('Unsupported LVCE workbench artifact')
  await cp(join(root, 'static'), join(output, 'workbench'), { recursive: true })
  const base = join(output, 'workbench', config.commit, 'packages')
  const replace = async (file: string, patches: [string, string][]) => {
    let source = await readFile(file, 'utf8')
    for (const [before, after] of patches) {
      if (source.split(before).length !== 2) throw new Error(`Unsupported workbench hook: ${before}`)
      source = source.replace(before, after)
    }
    await writeFile(file, source)
  }
  await replace(join(output, 'workbench/index.html'), [
    ['</head>', '<link rel="stylesheet" href="/collaboration.css"><script type="module" src="/workbench-client.js"></script></head>'],
  ])
  const editorFile = join(base, 'editor-worker/dist/editorWorkerMain.js')
  await writeFile(editorFile, patchEditorSource(await readFile(editorFile, 'utf8'), '19.60.2', await readFile(new URL('../patches/editor-collaboration.js', import.meta.url), 'utf8')))
  await replace(join(base, 'renderer-process/dist/rendererProcessMain.js'), [
    ['const platform = Remote;', 'const platform = Web;'],
    ['const send = (method, uid, ...args) => {', `const send = (method, uid, ...args) => {
  if (method === 'Viewlet.executeViewletCommand' && get$b(uid)?.state?.$Viewlet?.classList.contains('Editor') && globalThis.lvceCollaboration && !['handleFocus', 'handleBlur', '__renderPending'].includes(args[0])) {
    globalThis.lvceCollaboration.localUid(uid, ...args).catch(console.error);
    return;
  }`],
    ['const commandMap = {', `const commandMap = {
  'Collaboration.local': (...args) => globalThis.lvceCollaboration.local(...args),
  'Collaboration.action': (...args) => globalThis.lvceCollaboration.action(...args),`],
  ])
  await replace(join(base, 'renderer-worker/dist/rendererWorkerMain.js'), [
    ['const platform = Remote;', 'const platform = Web$1;'],
    ['const runEditorCommand = async (editor, fullId, restArgs, preserveFocus = false) => {', `const runEditorCommand = async (editor, fullId, restArgs, preserveFocus = false) => {
  if (editor.uri.startsWith('memfs:///collaboration/') && !['Editor.loadContent', 'Editor.updateDiagnostics', 'Editor.handleFocus', 'Editor.handleBlur', 'Editor.resize'].includes(fullId)) return state$A.rpc.invoke('Collaboration.local', editor, fullId, restArgs, preserveFocus);`],
    ['const commandMap = {', `const commandMap = {
  'Collaboration.raw': async (editor, command, args, preserveFocus) => {
    await actualInvoke(command, editor.uid, ...args);
    const result = await renderPendingEditors(editor, preserveFocus);
    await invoke$K('Viewlet.executeCommands', result.commands.map(c => typeof c[0] === 'string' && c[0].startsWith('Viewlet.') ? c : ['Viewlet.send', editor.uid, ...c]));
    return result;
  },
  'Collaboration.state': (uid) => actualInvoke('Collaboration.state', uid),
  'Collaboration.editors': () => Object.values(getAllInstances()).filter(x => x.state?.uri?.startsWith('memfs:///collaboration/') && (x.moduleId === 'Editor' || x.moduleId === 'EditorText')).map(x => x.state),
  'Collaboration.snapshot': async (editor, text, selections) => {
    await actualInvoke('Collaboration.snapshot', editor.uid, text, selections);
    const state = await renderPendingEditors(editor, true);
    await invoke$K('Viewlet.executeCommands', state.commands.map(c => typeof c[0] === 'string' && c[0].startsWith('Viewlet.') ? c : ['Viewlet.send', editor.uid, ...c]));
  },
  'Collaboration.workspace': async (files) => {
    const main = Object.values(getAllInstances()).find(x => x.moduleId === 'Main');
    if (main) await execute$8('Viewlet.executeViewletCommand', main.state.uid, 'closeAllEditors');
    await invoke$N('FileSystem.mkdir', 'memfs:///collaboration');
    for (const [name, text] of Object.entries(files)) {
      const parts = name.split('/'); parts.pop();
      let path = 'memfs:///collaboration';
      for (const part of parts) { path += '/' + part; await invoke$N('FileSystem.mkdir', path); }
      await writeFile$f('memfs:///collaboration/' + name, text);
    }
    await setPath('memfs:///collaboration');
  },
  'Collaboration.openFile': async (uri) => {
    const main = Object.values(getAllInstances()).find(x => x.moduleId === 'Main');
    return execute$8('Viewlet.executeViewletCommand', main.state.uid, 'openUri', uri);
  },
  'Collaboration.writeFile': (name, text) => writeFile$f('memfs:///collaboration/' + name, text),
  'Collaboration.log': async (text) => {
    await writeFile$f('memfs:///collaboration-output.txt', text);
    const output = Object.values(getAllInstances()).find(x => x.moduleId === 'Output');
    if (output) await execute$8('Viewlet.executeViewletCommand', output.state.uid, 'refresh');
  },
  'Collaboration.output': async () => {
    const layout = Object.values(getAllInstances()).find(x => x.moduleId === 'Layout');
    await execute$8('Viewlet.executeViewletCommand', layout.state.uid, 'showPanel', 'Output');
    const output = Object.values(getAllInstances()).find(x => x.moduleId === 'Output');
    if (output) await execute$8('Viewlet.executeViewletCommand', output.state.uid, 'selectChannel', 'Collaboration');
  },
  'Collaboration.closeEditors': async () => {
    const main = Object.values(getAllInstances()).find(x => x.moduleId === 'Main');
    if (main) await execute$8('Viewlet.executeViewletCommand', main.state.uid, 'closeAllEditors');
  },
  'Collaboration.pick': (items) => showQuickPick({items: items.map(item => ({...item, value: item}))}),
  'Collaboration.input': (options) => showQuickInput(options),
  'Collaboration.controls': (...args) => state$A.rpc.invoke('Collaboration.action', ...args),`],
    ['return extensions.flatMap(getCommandsFromExtension);', `return [...extensions.flatMap(getCommandsFromExtension), { id: 'Collaboration.controls', label: 'Collaboration: Session controls' }];`],
    ["const executeCommand = async (id, ...args) => {", "const executeCommand = async (id, ...args) => {\n  if (id === 'Collaboration.controls') return state$A.rpc.invoke('Collaboration.action', ...args);"],
  ])
  await replace(join(base, 'main-area-worker/dist/mainAreaWorkerMain.js'), [
    ['const getViewletModuleId$1 = async (uri, opener, applicationId) => {', "const getViewletModuleId$1 = async (uri, opener, applicationId) => {\n  if (uri.startsWith('memfs:///collaboration/')) return 'Editor';"],
  ])
  await replace(join(base, 'output-view/dist/outputViewWorkerMain.js'), [
    ['const getExtensionOptions = async () => {', "const getExtensionOptions = async () => {\n  const collaboration = { id: 'Collaboration', label: 'Collaboration', uri: 'memfs:///collaboration-output.txt' };"],
    ['return channels;', 'return [collaboration, ...channels];'],
    ["error(error$1);\n    return [];", "error(error$1);\n    return [collaboration];"],
  ])
}

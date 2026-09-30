// Inserted into pinned editor-worker 19.60.2 by patch-editor.js.
// This bypasses editing history for remote snapshots, while retaining LVCE's
// layout, tokenization, selection and rendering pipeline.
const collaborationSnapshot = async (id, text, selections) => {
  const before = getEditor$1(id);
  const after = setText$1(before, text);
  const derived = await updateDerivedState(before, {
    ...after,
    selections: new Uint32Array(selections),
    undoStack: [],
    redoStack: [],
    cursorUndoStack: [],
    autoClosingRanges: [],
    canCoalesceTyping: false,
    incrementalEdits: emptyIncrementalEdits,
    invalidStartIndex: 0,
  });
  set$8(id, before, derived);
};
const collaborationState = (id) => {
  const editor = getEditor$1(id);
  return {
    text: editor.lines.join('\n'),
    selections: Array.from(editor.selections),
    rowHeight: editor.rowHeight,
    charWidth: editor.charWidth,
    deltaX: editor.deltaX,
    deltaY: editor.deltaY,
  };
};

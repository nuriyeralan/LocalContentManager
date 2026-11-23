"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "app.js"), "utf8");
const editorCode = source.slice(
  source.indexOf("function editCategoryDescription("),
  source.indexOf("function recommendSelectedCategory("),
);
const keyboardCode = source.slice(
  source.indexOf('document.addEventListener("keydown",'),
  source.indexOf('elements.closeOrganizer.addEventListener("click",'),
);

function fixture(updateCategoryDescription = async () => ({ ok: true, data: { state: {} } })) {
  const hidden = new Set();
  const elements = {
    categoryEditor: {
      open: false,
      showModal() { this.open = true; },
      close() { this.open = false; },
    },
    categoryEditorName: {},
    categoryEditorDescription: { value: "", focus() { this.focused = true; } },
    categoryEditorError: {
      textContent: "",
      classList: { add: (name) => hidden.add(name), remove: (name) => hidden.delete(name) },
    },
    categoryEditorSave: { disabled: false },
    categoryEditorCancel: { disabled: false },
    detailsDialog: { open: true },
    visionSettingsDialog: { open: false },
  };
  const state = { busy: false, editingCategory: null, selectedAssetId: "current-image" };
  const toasts = [];
  const calls = [];
  let refreshedState;
  const context = vm.createContext({
    state,
    elements,
    prompt: () => { throw new Error("prompt() is not supported."); },
    api: {
      updateCategoryDescription: async (...args) => {
        calls.push(args);
        return updateCategoryDescription(...args);
      },
    },
    requireSuccess: (result) => {
      if (!result?.ok) throw new Error(result.error);
      return result.data;
    },
    setLibrary: (value) => { refreshedState = value; },
    schedulePreviewRecommendations: () => {},
    showToast: (...args) => toasts.push(args),
    render: () => {},
    document: {
      addEventListener: (_name, handler) => { context.keydown = handler; },
    },
  });
  vm.runInContext(editorCode, context);
  vm.runInContext(keyboardCode, context);
  return {
    state, elements, hidden, toasts, calls,
    open: (category = { name: "Cartoon", description: "Existing description." }) =>
      context.editCategoryDescription(category),
    save: () => context.saveCategoryDescription({ preventDefault() {} }),
    key: (key) => context.keydown({ key, preventDefault() {} }),
    get refreshedState() { return refreshedState; },
  };
}

test("opens a focused in-app category editor without Electron's unsupported prompt", () => {
  const { open, elements, state, calls } = fixture();
  open();
  assert.equal(elements.categoryEditor.open, true);
  assert.equal(elements.categoryEditorName.textContent, "Cartoon");
  assert.equal(elements.categoryEditorDescription.value, "Existing description.");
  assert.equal(elements.categoryEditorDescription.focused, true);
  assert.equal(state.selectedAssetId, "current-image");
  assert.equal(calls.length, 0);
});

test("vision settings isolate underlying preview navigation and Escape", () => {
  const editor = fixture();
  editor.elements.visionSettingsDialog.open = true;
  for (const key of ["Escape", "ArrowLeft", "ArrowRight", "Delete"]) editor.key(key);
  assert.equal(editor.elements.detailsDialog.open, true);
  assert.equal(editor.state.selectedAssetId, "current-image");
});

test("saving updates the definition without moving the preview and allows clearing it", async () => {
  const updated = { categories: [{ name: "Cartoon", description: "" }] };
  const editor = fixture(async () => ({ ok: true, data: { state: updated } }));
  editor.open();
  editor.elements.categoryEditorDescription.value = "";
  await editor.save();
  assert.deepEqual(editor.calls, [["Cartoon", ""]]);
  assert.equal(editor.refreshedState, updated);
  assert.equal(editor.elements.categoryEditor.open, false);
  assert.equal(editor.state.selectedAssetId, "current-image");
  assert.equal(editor.state.busy, false);
});

test("failed saves remain visible with text preserved and can be retried", async () => {
  let fail = true;
  const editor = fixture(async () => fail
    ? { ok: false, error: "Library is read-only." }
    : { ok: true, data: { state: {} } });
  editor.open();
  editor.elements.categoryEditorDescription.value = "New description.";
  await editor.save();
  assert.equal(editor.elements.categoryEditor.open, true);
  assert.equal(editor.elements.categoryEditorDescription.value, "New description.");
  assert.equal(editor.elements.categoryEditorError.textContent, "Library is read-only.");
  assert.equal(editor.hidden.has("hidden"), false);
  assert.equal(editor.elements.categoryEditorSave.disabled, false);
  assert.deepEqual(editor.toasts[0], ["Library is read-only.", true]);
  fail = false;
  await editor.save();
  assert.equal(editor.calls.length, 2);
  assert.equal(editor.elements.categoryEditor.open, false);
});

test("pending saves prevent duplicate writes and re-opening another category", async () => {
  let complete;
  const editor = fixture(() => new Promise((resolve) => { complete = resolve; }));
  editor.open();
  const saving = editor.save();
  assert.equal(editor.elements.categoryEditorSave.disabled, true);
  assert.equal(editor.elements.categoryEditorCancel.disabled, true);
  assert.equal(editor.elements.categoryEditorDescription.disabled, true);
  editor.key("Escape");
  assert.equal(editor.elements.categoryEditor.open, true);
  editor.open({ name: "Kids", description: "" });
  await editor.save();
  assert.equal(editor.state.editingCategory, "Cartoon");
  assert.equal(editor.calls.length, 1);
  complete({ ok: true, data: { state: {} } });
  await saving;
  assert.equal(editor.elements.categoryEditorDescription.disabled, false);
});

test("category editing isolates preview shortcuts and Escape closes only the editor", () => {
  const editor = fixture();
  editor.open();
  for (const key of ["ArrowLeft", "ArrowRight", "Delete"]) editor.key(key);
  assert.equal(editor.elements.categoryEditor.open, true);
  assert.equal(editor.state.selectedAssetId, "current-image");
  editor.key("Escape");
  assert.equal(editor.elements.categoryEditor.open, false);
  assert.equal(editor.elements.detailsDialog.open, true);
  assert.equal(editor.calls.length, 0);
});

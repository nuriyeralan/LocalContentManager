"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "app.js"), "utf8");
const progressCode = source.slice(
  source.indexOf("api.onLibraryProgress("), source.indexOf("api.onOrganizerProgress("),
);

test("library progress stays indeterminate through discovery and exposes completion and errors", () => {
  function element() {
    const classes = new Set(["hidden"]);
    return { classes, classList: {
      remove: (value) => classes.delete(value),
      toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value),
    } };
  }
  const elements = Object.fromEntries([
    "libraryProgress", "libraryProgressBar", "libraryProgressText", "libraryProgressDirectory",
  ].map((key) => [key, element()]));
  let handler;
  vm.runInNewContext(progressCode, {
    elements, api: { onLibraryProgress: (value) => { handler = value; } },
    formatDuration: () => "5s",
  });
  handler({ phase: "scanning", current: 160, discovered: 10_000, directory: "\\\\nas\\photos", elapsedMs: 5000 });
  assert.equal(elements.libraryProgress.classes.has("hidden"), false);
  assert.match(elements.libraryProgressText.textContent, /160 of 10,000.*Finding files/);
  assert.equal(elements.libraryProgressDirectory.textContent, "\\\\nas\\photos");
  assert.equal(Object.hasOwn(elements.libraryProgressBar, "value"), false);
  handler({ phase: "categories", current: 10_000 });
  assert.match(elements.libraryProgressText.textContent, /Loading library categories/);
  handler({ phase: "complete", current: 10_000 });
  assert.match(elements.libraryProgressText.textContent, /Scan complete.*10,000/);
  assert.equal(elements.libraryProgressBar.classes.has("hidden"), true);
  handler({ phase: "error", message: "Network share disconnected." });
  assert.match(elements.libraryProgressText.textContent, /Scan failed.*disconnected/);
  assert.equal(elements.libraryProgressText.classes.has("error"), true);
});

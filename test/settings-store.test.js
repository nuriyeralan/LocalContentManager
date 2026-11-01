"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { SettingsStore } = require("../src/main/settings-store");

test("remembers media and recycling folders between launches", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-settings-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "settings.json");
  const auditPath = path.join(directory, "settings-audit.jsonl");

  const store = new SettingsStore(filePath, auditPath);
  await store.load();
  await store.commitUserSelection("mediaRoot", "C:\\Media", "media-folder-picker");
  await store.commitUserSelection(
    "recycleBinRoot",
    "D:\\Media Recycling",
    "recycle-folder-picker",
  );

  const reloaded = new SettingsStore(filePath, auditPath);
  assert.deepEqual(await reloaded.load(), {
    mediaRoot: "C:\\Media",
    recycleBinRoot: "D:\\Media Recycling",
    visionModel: null,
    visionConcurrency: 4,
  });

  await reloaded.commitUserSelection(
    "recycleBinRoot",
    null,
    "confirmed-recycle-clear",
  );
  const cleared = new SettingsStore(filePath, auditPath);
  assert.equal((await cleared.load()).recycleBinRoot, null);
  const audit = (await fs.readFile(auditPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    audit.map((entry) => [entry.field, entry.source]),
    [
      ["mediaRoot", "media-folder-picker"],
      ["recycleBinRoot", "recycle-folder-picker"],
      ["recycleBinRoot", "confirmed-recycle-clear"],
    ],
  );
});

test("rejects non-user settings mutations without changing persisted values", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-settings-guard-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "settings.json");
  const auditPath = path.join(directory, "settings-audit.jsonl");
  const store = new SettingsStore(filePath, auditPath);
  await store.load();
  await store.commitUserSelection("mediaRoot", "C:\\Media", "media-folder-picker");
  const before = await fs.readFile(filePath, "utf8");

  await assert.rejects(
    store.commitUserSelection("mediaRoot", "D:\\Agent Choice", "visual-analysis"),
    /only be changed through a confirmed user settings action/,
  );
  await assert.rejects(
    store.commitUserSelection("recycleBinRoot", null, "automatic-cleanup"),
    /only be changed through a confirmed user settings action/,
  );

  assert.equal(await fs.readFile(filePath, "utf8"), before);
});

test("persists only a user-selected vision model", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-model-setting-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "settings.json");
  const auditPath = path.join(directory, "settings-audit.jsonl");
  const store = new SettingsStore(filePath, auditPath);
  await store.load();

  await assert.rejects(
    store.commitUserSelection("visionModel", "gpt-5.6-sol-fast", "automatic-selection"),
    /only be changed through a confirmed user settings action/,
  );
  await store.commitUserSelection("visionModel", "gpt-5.6-sol-fast", "model-picker");

  assert.equal(store.get().visionModel, "gpt-5.6-sol-fast");
});

test("persists only an allowed user-selected vision concurrency", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-concurrency-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(
    path.join(directory, "settings.json"),
    path.join(directory, "settings-audit.jsonl"),
  );
  await store.load();

  await assert.rejects(
    store.commitUserSelection("visionConcurrency", 16, "concurrency-picker"),
    /must be 1, 2, 4, or 8/,
  );
  await assert.rejects(
    store.commitUserSelection("visionConcurrency", 8, "automatic-tuning"),
    /only be changed through a confirmed user settings action/,
  );
  await store.commitUserSelection("visionConcurrency", 8, "concurrency-picker");

  assert.equal(store.get().visionConcurrency, 8);
});

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

  const store = new SettingsStore(filePath);
  await store.load();
  await store.setMediaRoot("C:\\Media");
  await store.setRecycleBinRoot("D:\\Media Recycling");

  const reloaded = new SettingsStore(filePath);
  assert.deepEqual(await reloaded.load(), {
    mediaRoot: "C:\\Media",
    recycleBinRoot: "D:\\Media Recycling",
  });

  await reloaded.setRecycleBinRoot(null);
  const cleared = new SettingsStore(filePath);
  assert.equal((await cleared.load()).recycleBinRoot, null);
});

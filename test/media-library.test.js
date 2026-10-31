"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { MediaLibrary, isWithin } = require("../src/main/media-library");

test("scans supported media recursively and ignores other files", async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-library-"));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  await fs.mkdir(path.join(rootPath, "nested"));
  await Promise.all([
    fs.writeFile(path.join(rootPath, "photo.JPG"), "image"),
    fs.writeFile(path.join(rootPath, "nested", "clip.mp4"), "video"),
    fs.writeFile(path.join(rootPath, "notes.txt"), "not media"),
  ]);

  const library = new MediaLibrary();
  const snapshot = await library.scan(rootPath);

  assert.equal(snapshot.assets.length, 2);
  assert.deepEqual(
    snapshot.assets.map((item) => item.type).sort(),
    ["image", "video"],
  );
  assert.equal(snapshot.assets.some((item) => Object.hasOwn(item, "absolutePath")), false);
});

test("moves without overwriting an existing destination", async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-move-"));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  await fs.writeFile(path.join(rootPath, "photo.jpg"), "source");
  await fs.mkdir(path.join(rootPath, "Organized"));
  await fs.writeFile(path.join(rootPath, "Organized", "photo.jpg"), "existing");

  const library = new MediaLibrary();
  const snapshot = await library.scan(rootPath);
  const asset = snapshot.assets.find((item) => item.relativePath === "photo.jpg");
  const movedRelative = await library.moveAsset(
    asset.id,
    asset.relativePath,
    path.join("Organized", "photo.jpg"),
  );

  assert.equal(movedRelative, path.join("Organized", "photo (2).jpg"));
  assert.equal(await fs.readFile(path.join(rootPath, "Organized", "photo.jpg"), "utf8"), "existing");
  assert.equal(await fs.readFile(path.join(rootPath, movedRelative), "utf8"), "source");
});

test("path containment rejects sibling directories", () => {
  const root = path.resolve("C:\\media");
  assert.equal(isWithin(root, path.join(root, "photos", "a.jpg")), true);
  assert.equal(isWithin(root, path.resolve(root, "..", "media-private", "a.jpg")), false);
});

test("recycles media under its relative path without overwriting", async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-recycle-"));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const rootPath = path.join(parent, "library");
  const recyclePath = path.join(parent, "recycle");
  await fs.mkdir(path.join(rootPath, "nested"), { recursive: true });
  await fs.mkdir(path.join(recyclePath, "nested"), { recursive: true });
  await fs.writeFile(path.join(rootPath, "nested", "photo.jpg"), "source");
  await fs.writeFile(path.join(recyclePath, "nested", "photo.jpg"), "existing");

  const library = new MediaLibrary();
  const snapshot = await library.scan(rootPath);
  const result = await library.deleteAsset(snapshot.assets[0].id, recyclePath);

  assert.equal(result.mode, "recycled");
  assert.equal(result.recycledRelativePath, path.join("nested", "photo (2).jpg"));
  await assert.rejects(fs.access(path.join(rootPath, "nested", "photo.jpg")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(recyclePath, "nested", "photo.jpg"), "utf8"), "existing");
  assert.equal(
    await fs.readFile(path.join(recyclePath, "nested", "photo (2).jpg"), "utf8"),
    "source",
  );
  assert.equal(library.publicSnapshot().assets.length, 0);
});

test("permanently deletes media when no recycling folder is configured", async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-delete-"));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  await fs.writeFile(path.join(rootPath, "photo.jpg"), "source");

  const library = new MediaLibrary();
  const snapshot = await library.scan(rootPath);
  const result = await library.deleteAsset(snapshot.assets[0].id, null);

  assert.equal(result.mode, "permanent");
  await assert.rejects(fs.access(path.join(rootPath, "photo.jpg")), { code: "ENOENT" });
  assert.equal(library.publicSnapshot().assets.length, 0);
});

test("falls back to verified copy-and-delete for cross-volume recycling", async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-cross-volume-"));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const rootPath = path.join(parent, "library");
  const recyclePath = path.join(parent, "recycle");
  await fs.mkdir(rootPath);
  await fs.mkdir(recyclePath);
  await fs.writeFile(path.join(rootPath, "photo.jpg"), "source");

  const library = new MediaLibrary();
  const snapshot = await library.scan(rootPath);
  const originalRename = fs.rename;
  fs.rename = async () => {
    const error = new Error("Cross-device move");
    error.code = "EXDEV";
    throw error;
  };
  try {
    const result = await library.deleteAsset(snapshot.assets[0].id, recyclePath);
    assert.equal(result.mode, "recycled");
  } finally {
    fs.rename = originalRename;
  }

  await assert.rejects(fs.access(path.join(rootPath, "photo.jpg")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(recyclePath, "photo.jpg"), "utf8"), "source");
});

test("rejects a recycling folder nested inside the library", async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-overlap-"));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const recyclePath = path.join(rootPath, "recycle");
  await fs.mkdir(recyclePath);
  await fs.writeFile(path.join(rootPath, "photo.jpg"), "source");

  const library = new MediaLibrary();
  const snapshot = await library.scan(rootPath);
  await assert.rejects(
    library.deleteAsset(snapshot.assets[0].id, recyclePath),
    /must be separate/,
  );
});

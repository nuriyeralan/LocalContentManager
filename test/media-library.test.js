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

test("uses converted previews for browser-unsupported image formats", async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-preview-"));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  await fs.writeFile(path.join(rootPath, "photo.heic"), "fixture");
  await fs.writeFile(path.join(rootPath, "photo.jpg"), "fixture");

  const library = new MediaLibrary();
  const snapshot = await library.scan(rootPath);
  const heic = snapshot.assets.find((item) => item.extension === ".heic");
  const jpeg = snapshot.assets.find((item) => item.extension === ".jpg");

  assert.match(heic.previewUrl, /^local-thumb:/);
  assert.equal(heic.previewUrl, heic.thumbnailUrl);
  assert.equal(jpeg.previewUrl, jpeg.mediaUrl);
});

test("10,000-file scans use 16 bounded metadata requests and report discovery without reading images", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-scan-parallel-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const rootPath = await fs.realpath(root);
  const originalStat = fs.stat;
  const originalReaddir = fs.readdir;
  const originalReadFile = fs.readFile;
  const count = 10_000;
  const date = new Date("2026-01-01T00:00:00.000Z");
  let active = 0;
  let peak = 0;
  let calls = 0;
  let rounds = 0;
  let scheduled = false;
  const pending = [];
  fs.readdir = async () => Array.from({ length: count }, (_, index) => ({
    name: `photo-${index}.jpg`,
    isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true,
  }));
  fs.stat = async (filePath) => {
    if (filePath === rootPath) return originalStat(filePath);
    calls += 1;
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => {
      pending.push(resolve);
      if (!scheduled) {
        scheduled = true;
        setImmediate(() => {
          scheduled = false;
          rounds += 1;
          for (const done of pending.splice(0)) done();
        });
      }
    });
    active -= 1;
    return { size: 1024, mtime: date, birthtime: date };
  };
  fs.readFile = async () => { throw new Error("Scanning must not read image content."); };
  try {
    const progress = [];
    const result = await new MediaLibrary().scan(root, (value) => progress.push(value));
    assert.equal(result.assets.length, count);
    assert.equal(calls, count);
    assert.equal(peak, 16);
    assert.equal(active, 0);
    assert.equal(rounds, Math.ceil(count / 16));
    assert.equal(result.assets[0].name, "photo-0.jpg");
    assert.equal(result.assets.at(-1).name, "photo-9999.jpg");
    assert.equal(progress[0].current, 0);
    assert.equal(progress.at(-1).current, count);
    assert.equal(progress.at(-1).discovered, count);
    assert.ok(progress.every((item, index) => !index || item.current >= progress[index - 1].current));
  } finally {
    fs.stat = originalStat;
    fs.readdir = originalReaddir;
    fs.readFile = originalReadFile;
  }
});

test("parallel scan errors drain in-flight requests and preserve the previous snapshot", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-scan-error-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 32 }, (_, index) =>
    fs.writeFile(path.join(root, `${index}.jpg`), "fixture")));
  const library = new MediaLibrary();
  const before = await library.scan(root);
  const originalStat = fs.stat;
  let active = 0;
  let calls = 0;
  fs.stat = async (filePath) => {
    if (filePath === library.rootPath) return originalStat(filePath);
    active += 1;
    const first = ++calls === 1;
    try {
      await new Promise((resolve) => setImmediate(resolve));
      if (first) throw new Error("Network metadata request failed.");
      return await originalStat(filePath);
    } finally {
      active -= 1;
    }
  };
  try {
    await assert.rejects(library.scan(root), /Network metadata request failed/);
    assert.equal(active, 0);
    assert.equal(calls, 16);
    assert.deepEqual(library.publicSnapshot(), before);
  } finally {
    fs.stat = originalStat;
  }
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
  const originalLink = fs.link;
  fs.link = async () => {
    const error = new Error("Cross-device move");
    error.code = "EXDEV";
    throw error;
  };
  try {
    const result = await library.deleteAsset(snapshot.assets[0].id, recyclePath);
    assert.equal(result.mode, "recycled");
  } finally {
    fs.link = originalLink;
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

test("recycling rejects linked destination folders without writing outside its root", async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-recycle-link-"));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "library");
  const recycle = path.join(parent, "recycle");
  const outside = path.join(parent, "outside");
  await fs.mkdir(path.join(root, "nested"), { recursive: true });
  await fs.mkdir(recycle);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(recycle, "nested"), "junction");
  await fs.writeFile(path.join(root, "nested", "photo.jpg"), "source");
  const library = new MediaLibrary();
  const snapshot = await library.scan(root);
  await assert.rejects(library.deleteAsset(snapshot.assets[0].id, recycle), /linked or invalid/);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.access(path.join(root, "nested", "photo.jpg"));
});

test("recycling never overwrites a destination created concurrently", async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-recycle-race-"));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "library");
  const recycle = path.join(parent, "recycle");
  await fs.mkdir(root);
  await fs.mkdir(recycle);
  await fs.writeFile(path.join(root, "photo.jpg"), "source");
  const library = new MediaLibrary();
  const snapshot = await library.scan(root);
  const originalLink = fs.link;
  let first = true;
  fs.link = async (source, destination) => {
    if (first) {
      first = false;
      await fs.writeFile(destination, "concurrent file");
    }
    return originalLink(source, destination);
  };
  try {
    const result = await library.deleteAsset(snapshot.assets[0].id, recycle);
    assert.equal(result.recycledRelativePath, "photo (2).jpg");
  } finally {
    fs.link = originalLink;
  }
  assert.equal(await fs.readFile(path.join(recycle, "photo.jpg"), "utf8"), "concurrent file");
  assert.equal(await fs.readFile(path.join(recycle, "photo (2).jpg"), "utf8"), "source");
});

test("a failed source unlink rolls back the recycling destination", async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-recycle-rollback-"));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "library");
  const recycle = path.join(parent, "recycle");
  await fs.mkdir(root);
  await fs.mkdir(recycle);
  const source = path.join(root, "photo.jpg");
  await fs.writeFile(source, "source");
  const library = new MediaLibrary();
  const snapshot = await library.scan(root);
  const originalUnlink = fs.unlink;
  fs.unlink = async (filePath) => {
    if (filePath === source) throw new Error("Source is locked.");
    return originalUnlink(filePath);
  };
  try {
    await assert.rejects(library.deleteAsset(snapshot.assets[0].id, recycle), /locked/);
  } finally {
    fs.unlink = originalUnlink;
  }
  assert.deepEqual(await fs.readdir(recycle), []);
  assert.equal(await fs.readFile(source, "utf8"), "source");
});

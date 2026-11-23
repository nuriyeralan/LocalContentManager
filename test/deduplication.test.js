"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Worker } = require("node:worker_threads");
const sharp = require("sharp");
const { Deduplication } = require("../src/main/deduplication");
const { assertUnchanged, scanDuplicates } = require("../src/main/duplicate-scanner");
const { hamming, imageDescriptors, descriptorsMatch } = require("../src/main/image-similarity");
const { MediaLibrary } = require("../src/main/media-library");

async function fixture(context) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-dedup-"));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const rootPath = path.join(parent, "library");
  const recycleRoot = path.join(parent, "recycle");
  await fs.mkdir(rootPath);
  await fs.mkdir(recycleRoot);
  const library = new MediaLibrary();
  const service = new Deduplication(library);
  context.after(() => service.cancel());
  return { rootPath, recycleRoot, library, service };
}

function artwork(width = 480, height = 320, variant = 0) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const xx = x / width;
      const yy = y / height;
      const offset = (y * width + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        const waves = Math.sin(xx * (9 + c * 3 + variant * 17) + yy * (5 + variant * 13)) * 55 +
          Math.cos(yy * (13 + c * 5 + variant * 11) - xx * 8) * 45;
        const shape = (xx - 0.37) ** 2 + (yy - 0.61) ** 2 < 0.025 ? (c === 0 ? 50 : -50) : 0;
        data[offset + c] = Math.max(0, Math.min(255, 128 + waves + shape));
      }
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } });
}

async function exactFixture(context) {
  const result = await fixture(context);
  await fs.mkdir(path.join(result.rootPath, "category"));
  await fs.writeFile(path.join(result.rootPath, "original.jpg"), "identical image bytes");
  await fs.writeFile(path.join(result.rootPath, "category", "copy.png"), "identical image bytes");
  await fs.writeFile(path.join(result.rootPath, "different.jpg"), "different image bytes");
  await fs.writeFile(path.join(result.rootPath, "clip.mp4"), "identical image bytes");
  await result.library.scan(result.rootPath);
  return result;
}

function decoderFixture(context, code) {
  const fork = childProcess.fork;
  const children = [];
  context.mock.method(childProcess, "fork", (file, args, options) => {
    const child = fork(file, args, { ...options, execArgv: ["--eval", code] });
    children.push(child);
    return child;
  });
  context.after(async () => {
    await Promise.all(children.map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      return new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill();
      });
    }));
  });
  return children;
}

test("SHA-256 finds identical bytes across paths/extensions, excludes videos, and reports progress", async (context) => {
  const { library, service } = await exactFixture(context);
  const progress = [];
  const plan = await service.scan("exact", "conservative", (value) => progress.push(value));
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].members.length, 2);
  assert.equal(plan.scanned, 3);
  assert.equal(plan.failed, 0);
  assert.equal(Object.hasOwn(plan.groups[0].members[0], "absolutePath"), false);
  assert.equal(Object.hasOwn(plan, "records"), false);
  assert.equal(progress[0].percent, 0);
  assert.equal(progress.at(-1).percent, 100);
  assert.ok(progress.every((item, index) => !index || item.percent >= progress[index - 1].percent));
  assert.equal(library.assets.size, 4);
});

test("spectral analysis groups resizes, recompression and light crops, but not unrelated artwork", async (context) => {
  const { rootPath, library, service } = await fixture(context);
  const original = await artwork().png().toBuffer();
  await fs.writeFile(path.join(rootPath, "original.png"), original);
  await sharp(original).resize(240, 160).jpeg({ quality: 78 }).toFile(path.join(rootPath, "small.jpg"));
  await sharp(original).extract({ left: 24, top: 16, width: 432, height: 288 })
    .png().toFile(path.join(rootPath, "light-crop.png"));
  await artwork(480, 320, 1).png().toFile(path.join(rootPath, "unrelated.png"));
  await library.scan(rootPath);
  const plan = await service.scan("similar", "conservative", () => {});
  assert.equal(plan.failed, 0);
  assert.equal(plan.groups.length, 1);
  assert.deepEqual(plan.groups[0].members.map((asset) => asset.name).sort(),
    ["light-crop.png", "original.png", "small.jpg"]);
  assert.equal(plan.groups[0].members[0].name, "original.png");
  assert.equal(plan.groups[0].members[0].width, 480);
  assert.equal(plan.groups[0].members[0].height, 320);
});

test("broader mode detects a substantial crop without changing conservative defaults", async (context) => {
  const { rootPath, library } = await fixture(context);
  const original = await artwork().png().toBuffer();
  await fs.writeFile(path.join(rootPath, "original.png"), original);
  await sharp(original).extract({ left: 0, top: 80, width: 360, height: 240 })
    .resize(270, 180).jpeg().toFile(path.join(rootPath, "crop.jpg"));
  await library.scan(rootPath);
  const input = { rootPath: library.rootPath, assets: library.assetsByType("image"), method: "similar" };
  const conservative = await scanDuplicates({ ...input, sensitivity: "conservative" });
  const broader = await scanDuplicates({ ...input, sensitivity: "broader" });
  assert.equal(conservative.groups.length, 0);
  assert.equal(broader.groups.length, 1);
});

test("similarity explicitly reports unsupported/unreadable files without losing valid matches", async (context) => {
  const { rootPath, library, service } = await fixture(context);
  const original = await artwork().png().toBuffer();
  await fs.writeFile(path.join(rootPath, "one.png"), original);
  await fs.writeFile(path.join(rootPath, "two.png"), original);
  await fs.writeFile(path.join(rootPath, "broken.heic"), "not an image");
  await library.scan(rootPath);
  const plan = await service.scan("similar", "conservative", () => {});
  assert.equal(plan.failed, 1);
  assert.equal(plan.failures[0].path, "broken.heic");
  assert.ok(plan.failures[0].error.length > 0);
  assert.equal(plan.groups.length, 1);
});

test("Windows spectral profiles match Sharp using PNG fixtures routed through the HEIC path", {
  skip: process.platform !== "win32",
}, async (context) => {
  const { rootPath, library, service } = await fixture(context);
  const original = await artwork().png().toBuffer();
  await fs.writeFile(path.join(rootPath, "original.png"), original);
  await sharp(original).png({ compressionLevel: 0 }).toFile(path.join(rootPath, "windows.HEIC"));
  await sharp(original).resize(240, 160).jpeg({ quality: 78 }).toFile(path.join(rootPath, "small.jpg"));
  await artwork(480, 320, 1).png().toFile(path.join(rootPath, "unrelated.png"));
  await library.scan(rootPath);
  const result = await service.scan("similar", "conservative", () => {}, 4);
  assert.equal(result.failed, 0);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].members.map((asset) => asset.name).sort(),
    ["original.png", "small.jpg", "windows.HEIC"]);
  const [originalRecord, windowsRecord] = ["original.png", "windows.HEIC"].map((name) =>
    service.plan.records.find((record) => record.asset.name === name));
  assert.notEqual(originalRecord.digest, windowsRecord.digest);
  assert.equal(windowsRecord.width, 480);
  assert.equal(windowsRecord.height, 320);
});

test("HEIC-only spectral scans do not load Sharp at all", {
  skip: process.platform !== "win32",
}, async (context) => {
  const { rootPath, library } = await fixture(context);
  const image = await artwork(240, 160).png().toBuffer();
  await fs.writeFile(path.join(rootPath, "one.HEIC"), image);
  await fs.writeFile(path.join(rootPath, "two.HEIF"), image);
  await library.scan(rootPath);
  decoderFixture(context, `
    const Module = require("node:module");
    const load = Module._load;
    Module._load = function(request, ...args) {
      if (request === "sharp") throw new Error("HEIC must not load Sharp.");
      return load.call(this, request, ...args);
    };
    require(process.argv[1]);
  `);
  const result = await scanDuplicates({
    rootPath: library.rootPath, assets: library.assetsByType("image"),
    method: "similar", sensitivity: "conservative", concurrency: 2,
  });
  assert.equal(result.failed, 0);
  assert.equal(result.analyzed, 2);
  assert.equal(result.groups.length, 1);
});

test("a Windows helper crash is counted and logged as a decoder failure without killing its analysis process", {
  skip: process.platform !== "win32",
}, async (context) => {
  const { rootPath, library } = await fixture(context);
  const image = await artwork(240, 160).png().toBuffer();
  await Promise.all(["a-crash.HEIC", "b-copy.HEIC", "c-copy.HEIC"].map((name) =>
    fs.writeFile(path.join(rootPath, name), image)));
  await library.scan(rootPath);
  const children = decoderFixture(context, `
    const childProcess = require("node:child_process");
    const spawn = childProcess.spawn;
    let crash = false;
    process.prependListener("message", (message) => { if (message.asset) crash = message.asset.name === "a-crash.HEIC"; });
    childProcess.spawn = (file, args, options) => crash
      ? spawn(process.execPath, ["-e", "process.exit(84)"], options)
      : spawn(file, args, options);
    require(process.argv[1]);
  `);
  const progress = [];
  const result = await scanDuplicates({
    rootPath: library.rootPath,
    assets: library.assetsByType("image").sort((a, b) => a.name.localeCompare(b.name)),
    method: "similar", sensitivity: "conservative", concurrency: 1,
  }, (value) => progress.push(value));
  assert.equal(children.length, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.analyzed, 2);
  assert.equal(result.decoderCrashes, 1);
  assert.equal(result.failures[0].kind, "decoderCrash");
  assert.match(result.failures[0].error, /Windows image decoder exited unexpectedly \(84\)/);
  assert.ok(progress.some((value) => value.failure?.path === "a-crash.HEIC"));
  assert.equal(result.groups[0].memberIds.length, 2);
});

test("flat images do not generate speculative spectral matches", () => {
  const one = imageDescriptors(Buffer.alloc(96 * 96 * 3, 80), "conservative");
  const two = imageDescriptors(Buffer.alloc(96 * 96 * 3, 90), "conservative");
  assert.equal(descriptorsMatch(one.full, two.full, "conservative"), false);
  assert.equal(hamming(0n, (1n << 63n) - 1n), 63);
});

test("choosing a canonical path automatically recycles every other group member without overwriting", async (context) => {
  const { rootPath, recycleRoot, library, service } = await exactFixture(context);
  const plan = await service.scan("exact", "conservative", () => {});
  const group = plan.groups[0];
  const keeper = group.members.find((asset) => asset.relativePath.includes("category"));
  const copy = group.members.find((asset) => asset.id !== keeper.id);
  await fs.writeFile(path.join(recycleRoot, copy.relativePath), "already recycled");
  const cleaned = [];
  const result = await service.recycleChoices(plan.id, [{ groupId: group.id, keeperId: keeper.id }], recycleRoot,
    async (asset) => cleaned.push(asset.id), () => {});
  assert.equal(result.status, "complete");
  assert.equal(result.moved.length, 1);
  assert.deepEqual(cleaned, [copy.id]);
  assert.equal(await fs.readFile(path.join(rootPath, keeper.relativePath), "utf8"), "identical image bytes");
  assert.equal(await fs.readFile(path.join(recycleRoot, "original.jpg"), "utf8"), "already recycled");
  assert.equal(await fs.readFile(path.join(recycleRoot, "original (2).jpg"), "utf8"), "identical image bytes");
  assert.equal(result.plan.groups.length, 0);
  assert.deepEqual(result.processedGroupIds, [group.id]);
  assert.ok(library.getAsset(keeper.id));
});

test("rejects permanent deletion, forged groups, keepers outside a group, and duplicate group choices", async (context) => {
  const { recycleRoot, library, service } = await exactFixture(context);
  const plan = await service.scan("exact", "conservative", () => {});
  const group = plan.groups[0];
  const [keeper] = group.members;
  const apply = (planId, choices, root = recycleRoot) =>
    service.recycleChoices(planId, choices, root, async () => {}, () => {});
  const valid = { groupId: group.id, keeperId: keeper.id };
  await assert.rejects(apply(plan.id, [valid], null), /never permanently deletes/);
  await assert.rejects(apply(plan.id, []), /at least one/);
  await assert.rejects(apply("old", [valid]), /no longer current/);
  await assert.rejects(apply(plan.id, [{ groupId: "forged", keeperId: keeper.id }]), /valid keeper/);
  await assert.rejects(apply(plan.id, [valid, valid]), /invalid/);
  const unrelated = [...library.assets.values()].find((asset) => asset.name === "different.jpg");
  await assert.rejects(
    apply(plan.id, [{ groupId: group.id, keeperId: unrelated.id }]),
    /valid keeper/,
  );
  assert.equal(library.assets.size, 4);
});

test("revalidates both keeper and copies before any move, invalidating stale scans", async (context) => {
  const { rootPath, recycleRoot, service } = await exactFixture(context);
  const plan = await service.scan("exact", "conservative", () => {});
  const group = plan.groups[0];
  const [keeper, copy] = group.members;
  await fs.writeFile(path.join(rootPath, keeper.relativePath), "changed keeper");
  const result = await service.recycleChoices(plan.id, [{ groupId: group.id, keeperId: keeper.id }], recycleRoot,
    async () => {}, () => {});
  assert.equal(result.status, "error");
  assert.match(result.error, /changed/);
  assert.equal(result.moved.length, 0);
  assert.equal(result.plan, null);
  await fs.access(path.join(rootPath, copy.relativePath));
  assert.deepEqual(await fs.readdir(recycleRoot), []);
});

test("changed images are reported during scans rather than accepted with a stale fingerprint", async (context) => {
  const { rootPath, library } = await exactFixture(context);
  await fs.writeFile(path.join(rootPath, "original.jpg"), "changed contents");
  const result = await scanDuplicates({
    rootPath: library.rootPath, assets: library.assetsByType("image"), method: "exact", sensitivity: "conservative",
  });
  assert.equal(result.failed, 1);
  assert.match(result.failures[0].error, /changed/);
  assert.equal(result.groups.length, 0);
});

test("verification catches content changes even if the supplied fingerprint is refreshed", async (context) => {
  const { rootPath, library } = await exactFixture(context);
  const result = await scanDuplicates({
    rootPath: library.rootPath, assets: library.assetsByType("image"), method: "exact", sensitivity: "conservative",
  });
  const record = result.records[0];
  await fs.writeFile(path.join(rootPath, record.asset.relativePath), "new contents");
  const { fingerprint } = require("../src/main/duplicate-scanner");
  record.fingerprint = fingerprint(await fs.stat(record.asset.absolutePath));
  await assert.rejects(assertUnchanged(library.rootPath, record, true), /different contents/);
});

test("a recycle failure reports completed moves explicitly and stops; no keeper is removed", async (context) => {
  const { rootPath, recycleRoot, library, service } = await exactFixture(context);
  await fs.writeFile(path.join(rootPath, "third.jpg"), "identical image bytes");
  await library.scan(rootPath);
  const plan = await service.scan("exact", "conservative", () => {});
  const group = plan.groups[0];
  const [keeper, ...copies] = group.members;
  const original = library.deleteAsset.bind(library);
  let calls = 0;
  library.deleteAsset = async (...args) => {
    calls += 1;
    if (calls === 2) throw new Error("Share became read-only.");
    return original(...args);
  };
  const result = await service.recycleChoices(plan.id, [{ groupId: group.id, keeperId: keeper.id }],
    recycleRoot, async () => {}, () => {});
  assert.equal(result.status, "error");
  assert.equal(result.moved.length, 1);
  assert.match(result.error, /read-only/);
  assert.equal(service.plan, null);
  await fs.access(path.join(rootPath, keeper.relativePath));
  await fs.access(path.join(rootPath, copies[1].relativePath));
});

test("scan cancellation terminates the worker and leaves all files untouched", async (context) => {
  const { library, service } = await exactFixture(context);
  const scanning = service.scan("exact", "conservative", () => {});
  const rejected = assert.rejects(scanning, /cancelled/);
  await service.cancel();
  await rejected;
  assert.equal(service.worker, null);
  assert.equal(service.plan, null);
  assert.equal(library.assets.size, 4);
});

test("invalid scan options and concurrent scans are rejected explicitly", async (context) => {
  const { service } = await exactFixture(context);
  await assert.rejects(service.scan("unknown", "broader", () => {}), /valid deduplication method/);
  for (const concurrency of [0, 3, 17, "16", null, NaN]) {
    await assert.rejects(service.scan("exact", "conservative", () => {}, concurrency), /parallel files/);
  }
  const scanning = service.scan("exact", "conservative", () => {});
  await assert.rejects(service.scan("exact", "conservative", () => {}), /already working/);
  await scanning;
});

test("all parallelism settings preserve exact and spectral results with monotonic progress", async (context) => {
  const { rootPath, library } = await fixture(context);
  const original = await artwork(240, 160).png().toBuffer();
  await Promise.all(Array.from({ length: 16 }, (_, index) =>
    fs.writeFile(path.join(rootPath, `copy-${index}.png`), original)));
  await artwork(240, 160, 1).png().toFile(path.join(rootPath, "unrelated.png"));
  await fs.writeFile(path.join(rootPath, "broken.heic"), "not an image");
  await library.scan(rootPath);
  for (const method of ["exact", "similar"]) {
    let baseline;
    for (const concurrency of [1, 2, 4, 8, 16]) {
      const progress = [];
      const result = await scanDuplicates({
        rootPath: library.rootPath, assets: library.assetsByType("image"),
        method, sensitivity: "conservative", concurrency,
      }, (value) => progress.push(value));
      const comparable = { ...result };
      delete comparable.concurrency;
      if (!baseline) baseline = comparable;
      else assert.deepEqual(comparable, baseline);
      assert.equal(result.concurrency, concurrency);
      assert.equal(Math.max(...progress.map((item) => item.active)), concurrency);
      assert.ok(progress.every((item) => item.active <= concurrency));
      assert.ok(progress.every((item, index) => !index || item.percent >= progress[index - 1].percent));
      assert.equal(progress.at(-1).percent, 100);
      assert.equal(result.groups[0].memberIds.length, 16);
      assert.equal(result.failed, method === "similar" ? 1 : 0);
    }
  }
});

test("cancellation after the parallel pool starts discards results and leaves the library untouched", async (context) => {
  const { library, service } = await exactFixture(context);
  let cancel;
  const scanning = service.scan("similar", "conservative", (progress) => {
    if (progress.active > 0 && !cancel) cancel = service.cancel();
  }, 16);
  await assert.rejects(scanning, /cancelled/);
  await cancel;
  assert.equal(service.worker, null);
  assert.equal(service.plan, null);
  assert.equal(library.assets.size, 4);
});

test("a fatal decoder exit is reported against its file and the replacement continues the scan", async (context) => {
  const { rootPath, library } = await fixture(context);
  const original = await artwork(240, 160).png().toBuffer();
  await Promise.all(["a-crash.png", "b-copy.png", "c-copy.png", "d-copy.png"].map((name) =>
    fs.writeFile(path.join(rootPath, name), original)));
  await library.scan(rootPath);
  const children = decoderFixture(context, `
    process.prependListener("message", (message) => {
      if (message.asset?.name === "a-crash.png") {
        process.stderr.write("Simulated native decoder failure");
        process.exit(77);
      }
    });
    require(process.argv[1]);
  `);
  const progress = [];
  const result = await scanDuplicates({
    rootPath: library.rootPath,
    assets: library.assetsByType("image").sort((a, b) => a.name.localeCompare(b.name)),
    method: "similar", sensitivity: "conservative", concurrency: 1,
  }, (value) => progress.push(value));
  assert.equal(children.length, 2);
  assert.equal(result.analyzed, 3);
  assert.equal(result.failed, 1);
  assert.equal(result.decoderCrashes, 1);
  assert.equal(result.failures[0].path, "a-crash.png");
  assert.equal(result.failures[0].kind, "decoderCrash");
  assert.match(result.failures[0].error, /exit 77.*Simulated native decoder failure/);
  assert.equal(result.groups[0].memberIds.length, 3);
  assert.ok(progress.some((value) => value.failure?.path === "a-crash.png"));
  assert.equal(progress.at(-1).percent, 100);
  assert.deepEqual((await fs.readdir(rootPath)).sort(),
    ["a-crash.png", "b-copy.png", "c-copy.png", "d-copy.png"]);
  assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
});

test("a decoder crash on the final file completes with explicit failures rather than hanging", async (context) => {
  const { rootPath, library } = await fixture(context);
  await fs.writeFile(path.join(rootPath, "crash.png"), "fixture");
  await library.scan(rootPath);
  decoderFixture(context, `
    process.on("message", (message) => {
      if (message.type === "init") process.send({ type: "ready" });
      else process.exit(78);
    });
    process.on("disconnect", () => process.exit(0));
  `);
  const result = await scanDuplicates({
    rootPath: library.rootPath, assets: library.assetsByType("image"),
    method: "similar", sensitivity: "conservative", concurrency: 16,
  });
  assert.equal(result.failed, 1);
  assert.equal(result.analyzed, 0);
  assert.equal(result.decoderCrashes, 1);
  assert.equal(result.groups.length, 0);
});

test("decoder startup failure rejects the scan and stops every process", async (context) => {
  const { library } = await exactFixture(context);
  const children = decoderFixture(context, "process.exit(79);");
  await assert.rejects(scanDuplicates({
    rootPath: library.rootPath, assets: library.assetsByType("image"),
    method: "similar", sensitivity: "conservative", concurrency: 4,
  }), /worker stopped unexpectedly.*79/);
  assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
});

test("terminating the coordinating thread closes its decoder processes without leaving orphans", async (context) => {
  const { library } = await exactFixture(context);
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const childProcess = require("node:child_process");
    const originalFork = childProcess.fork;
    childProcess.fork = (file, args, options) => {
      const child = originalFork(file, args, {
        ...options,
        execArgv: ["--eval", \`
          process.on("message", (message) => {
            if (message.type === "init") process.send({ type: "ready" });
          });
          process.on("disconnect", () => process.exit(0));
        \`],
      });
      parentPort.postMessage({ pid: child.pid });
      return child;
    };
    const { scanDuplicates } = require(workerData.scanner);
    scanDuplicates(workerData.input, (progress) => parentPort.postMessage({ progress }))
      .catch((error) => { throw error; });
  `, { eval: true, workerData: {
    scanner: require.resolve("../src/main/duplicate-scanner"),
    input: { rootPath: library.rootPath, assets: library.assetsByType("image"),
      method: "similar", sensitivity: "conservative", concurrency: 2 },
  } });
  context.after(() => worker.terminate());
  const pids = [];
  context.after(() => {
    for (const pid of pids) {
      try { process.kill(pid); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  });
  await new Promise((resolve, reject) => {
    worker.on("error", reject);
    worker.on("message", (message) => {
      if (message.pid) pids.push(message.pid);
      if (message.progress?.active === 2) resolve();
    });
  });
  await worker.terminate();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const alive = pids.filter((pid) => {
      try { process.kill(pid, 0); return true; } catch (error) {
        if (error.code !== "ESRCH") throw error;
        return false;
      }
    });
    if (!alive.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Decoder processes survived scan cancellation.");
});

test("repeated mixed-format spectral batches at 16 processes retain every file and preserve results", async (context) => {
  const { rootPath, library, service } = await fixture(context);
  const original = await artwork(1024, 768).png().toBuffer();
  const buffers = await Promise.all([
    sharp(original).jpeg({ quality: 85 }).toBuffer(), sharp(original).webp().toBuffer(),
    sharp(original).tiff({ compression: "deflate" }).toBuffer(),
  ]);
  const formats = [["png", original], ["jpg", buffers[0]], ["webp", buffers[1]], ["tif", buffers[2]]];
  await Promise.all(Array.from({ length: 128 }, (_, index) => {
    const [extension, buffer] = formats[index % formats.length];
    return fs.writeFile(path.join(rootPath, `image-${index}.${extension}`), buffer);
  }));
  await library.scan(rootPath);
  for (let batch = 0; batch < 2; batch += 1) {
    const result = await service.scan("similar", "broader", () => {}, 16);
    assert.equal(result.analyzed, 128);
    assert.equal(result.failed, 0);
    assert.equal(result.decoderCrashes, 0);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].members.length, 128);
  }
  assert.equal((await fs.readdir(rootPath)).length, 128);
});

test("recycling hard-linked duplicates preserves and revalidates the surviving canonical image", async (context) => {
  const { rootPath, recycleRoot, library, service } = await fixture(context);
  const original = path.join(rootPath, "original.jpg");
  await fs.writeFile(original, "hard-linked image bytes");
  await fs.link(original, path.join(rootPath, "copy-one.jpg"));
  await fs.link(original, path.join(rootPath, "copy-two.jpg"));
  await library.scan(rootPath);
  const plan = await service.scan("exact", "conservative");
  const group = plan.groups[0];
  const [keeper, ...copies] = group.members;
  const result = await service.recycleChoices(
    plan.id, [{ groupId: group.id, keeperId: keeper.id }],
    recycleRoot, async () => {}, () => {});
  assert.equal(result.status, "complete");
  assert.equal(result.moved.length, 2);
  assert.equal(await fs.readFile(path.join(rootPath, keeper.relativePath), "utf8"), "hard-linked image bytes");
});

test("one batch applies reviewed groups while retaining every image in unreviewed groups", async (context) => {
  const { rootPath, recycleRoot, library, service } = await fixture(context);
  await Promise.all([
    fs.writeFile(path.join(rootPath, "a-one.jpg"), "group a"),
    fs.writeFile(path.join(rootPath, "a-two.jpg"), "group a"),
    fs.writeFile(path.join(rootPath, "b-one.jpg"), "group b"),
    fs.writeFile(path.join(rootPath, "b-two.jpg"), "group b"),
    fs.writeFile(path.join(rootPath, "c-one.jpg"), "group c"),
    fs.writeFile(path.join(rootPath, "c-two.jpg"), "group c"),
  ]);
  await library.scan(rootPath);
  const plan = await service.scan("exact", "conservative");
  assert.equal(plan.groups.length, 3);
  const reviewed = [plan.groups[0], plan.groups[2]];
  const unreviewed = plan.groups[1];
  const choices = reviewed.map((group) => ({
    groupId: group.id,
    keeperId: group.members[0].id,
  }));
  const result = await service.recycleChoices(
    plan.id, choices, recycleRoot, async () => {}, () => {});
  assert.equal(result.status, "complete");
  assert.equal(result.moved.length, 2);
  assert.deepEqual(new Set(result.processedGroupIds), new Set(reviewed.map((group) => group.id)));
  assert.equal(result.plan.groups.length, 1);
  assert.equal(result.plan.groups[0].id, unreviewed.id);
  for (const asset of unreviewed.members) await fs.access(path.join(rootPath, asset.relativePath));
});

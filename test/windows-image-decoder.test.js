"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sharp = require("sharp");
const { decodeImage } = require("../src/main/duplicate-scanner");
const { decodeWindowsImage, parseResponse, usesWindowsDecoder } = require("../src/main/windows-image-decoder");

const windows = { skip: process.platform !== "win32" };
const PIXEL_BYTES = 96 * 96 * 3;
const HELPER = path.join(__dirname, "..", ".runtime", "wic", "WindowsImageDecoder.exe");

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-wic-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function response(status, width, height, payload) {
  const header = Buffer.alloc(20);
  header.write("LCW1");
  header.writeInt32LE(status, 4);
  header.writeInt32LE(width, 8);
  header.writeInt32LE(height, 12);
  header.writeInt32LE(payload.length, 16);
  return Buffer.concat([header, payload]);
}

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code !== "ESRCH") throw error;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("A Windows image decoder helper was left running.");
}

test("only HEIC/HEIF paths route to Windows; other formats retain Sharp", () => {
  assert.equal(usesWindowsDecoder("C:\\photos\\image.HEIC"), true);
  assert.equal(usesWindowsDecoder("C:\\photos\\image.heif"), true);
  assert.equal(usesWindowsDecoder("C:\\photos\\image.avif"), false);
  assert.equal(usesWindowsDecoder("C:\\photos\\image.jpeg"), false);
});

test("the helper protocol validates RGB shape and the exact 100-megapixel limit", () => {
  const payload = Buffer.alloc(PIXEL_BYTES);
  assert.equal(parseResponse(response(0, 10000, 10000, payload)).pixels.length, PIXEL_BYTES);
  assert.throws(() => parseResponse(response(0, 10001, 10000, payload)), /invalid dimensions/);
  assert.throws(() => parseResponse(response(0, 0, 100, payload)), /invalid dimensions/);
  assert.throws(() => parseResponse(response(0, 10, 10, Buffer.alloc(12))), /RGB pixels/);
  assert.throws(() => parseResponse(response(2, 10, 10, payload)), /invalid dimensions/);
  assert.throws(() => parseResponse(Buffer.alloc(20)), /invalid response/);
  assert.throws(() => parseResponse(response(0, 10, 10, payload).subarray(0, 30)), /payload length/);
});

test("codec failures give explicit HEIF/HEVC guidance without claiming corruption", () => {
  assert.throws(() => parseResponse(response(1, 0x88982f50 | 0, 0, Buffer.from("No installed codec."))),
    /0x88982f50.*No installed codec.*Verify this file.*HEIF Image Extensions.*HEVC/);
});

test("full-frame Windows pixels preserve all eight EXIF orientations and original dimensions", windows, async (context) => {
  const root = await fixture(context);
  const width = 80;
  const height = 120;
  const colors = [[240, 20, 20], [20, 240, 20], [20, 20, 240], [240, 240, 20]];
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = colors[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)];
      pixels.set(color, (y * width + x) * 3);
    }
  }
  const corners = [
    [0, 1, 2, 3], [1, 0, 3, 2], [3, 2, 1, 0], [2, 3, 0, 1],
    [0, 2, 1, 3], [2, 0, 3, 1], [3, 1, 2, 0], [1, 3, 0, 2],
  ];
  for (let orientation = 1; orientation <= 8; orientation += 1) {
    const file = path.join(root, `orientation-${orientation}.jpg`);
    const original = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .withMetadata({ orientation }).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
    await fs.writeFile(file, original);
    const result = await decodeWindowsImage(file);
    assert.equal(result.width, orientation >= 5 ? height : width);
    assert.equal(result.height, orientation >= 5 ? width : height);
    assert.equal(result.pixels.length, PIXEL_BYTES);
    for (const [index, [x, y]] of [[12, 12], [84, 12], [12, 84], [84, 84]].entries()) {
      const actual = result.pixels.subarray((y * 96 + x) * 3, (y * 96 + x) * 3 + 3);
      const expected = colors[corners[orientation - 1][index]];
      assert.ok(actual.every((value, channel) => Math.abs(value - expected[channel]) <= 6),
        `Orientation ${orientation}, corner ${index}: ${[...actual]} instead of ${expected}`);
    }
    assert.deepEqual(await fs.readFile(file), original);
  }
});

test("Windows normalizes transparency onto white and converts embedded color profiles to sRGB", windows, async (context) => {
  const root = await fixture(context);
  const transparent = path.join(root, "transparent.png");
  await sharp({ create: { width: 120, height: 80, channels: 4,
    background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toFile(transparent);
  const result = await decodeWindowsImage(transparent);
  assert.equal(result.width, 120);
  assert.equal(result.height, 80);
  assert.ok(result.pixels.every((value) => value === 255));

  const profile = path.join(root, "color-profile.png");
  await sharp({ create: { width: 120, height: 80, channels: 3,
    background: { r: 180, g: 50, b: 80 } } }).withIccProfile("p3").png().toFile(profile);
  const expected = await decodeImage(profile);
  const actual = await decodeWindowsImage(profile);
  assert.ok(actual.pixels.every((value, index) => Math.abs(value - expected.pixels[index]) <= 6));
});

test("the HEIC route uses Windows full-frame decoding and corrupt inputs remain explicit errors", windows, async (context) => {
  const root = await fixture(context);
  const image = path.join(root, "Unicode-\u00e9-+.HEIC");
  const original = await sharp({ create: { width: 640, height: 480, channels: 3,
    background: { r: 25, g: 150, b: 75 } } }).png().toBuffer();
  await fs.writeFile(image, original);
  const result = await decodeImage(image);
  assert.equal(result.width, 640);
  assert.equal(result.height, 480);
  assert.equal(result.pixels.length, PIXEL_BYTES);
  assert.ok(result.pixels.every((value, index) => Math.abs(value - [25, 150, 75][index % 3]) <= 2));
  assert.deepEqual(await fs.readFile(image), original);
  const broken = path.join(root, "broken.heic");
  await fs.writeFile(broken, "not an image");
  await assert.rejects(decodeImage(broken), /Windows full-image decoding failed/);
});

test("WIC rejects oversized image metadata before attempting full pixel decoding", windows, async (context) => {
  const root = await fixture(context);
  const file = path.join(root, "oversized.bmp");
  const width = 10001;
  const height = 10000;
  const imageBytes = Math.ceil(width / 32) * 4 * height;
  const buffer = Buffer.alloc(62 + imageBytes);
  buffer.write("BM");
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(62, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(1, 28);
  buffer.writeUInt32LE(imageBytes, 34);
  buffer.writeUInt32LE(2, 46);
  buffer.writeUInt32LE(2, 50);
  buffer.fill(255, 58, 61);
  await fs.writeFile(file, buffer);
  await assert.rejects(decodeWindowsImage(file), /100-megapixel input limit/);
});

test("a helper process crash is a reported file error and the failed helper is reaped", windows, async (context) => {
  const spawn = childProcess.spawn;
  let helper;
  context.mock.method(childProcess, "spawn", () => {
    helper = spawn(process.execPath, ["-e", "process.exit(82)"], { stdio: ["pipe", "pipe", "pipe"] });
    return helper;
  });
  await assert.rejects(decodeWindowsImage(path.resolve("crash.heic")), (error) =>
    error.decoderCrash === true && /exited unexpectedly \(82\)/.test(error.message));
  assert.equal(helper.exitCode, 82);
});

test("a missing helper is an explicit installation error rather than a Sharp fallback", windows, async (context) => {
  const spawn = childProcess.spawn;
  context.mock.method(childProcess, "spawn", () =>
    spawn(path.join(os.tmpdir(), `missing-wic-helper-${process.pid}.exe`), [], {
      stdio: ["pipe", "pipe", "pipe"],
    }));
  await assert.rejects(decodeWindowsImage(path.resolve("missing.heic")),
    /helper is missing.*Reinstall the app.*build:decoder/);
  await assert.rejects(decodeWindowsImage("relative.heic"), /absolute image path/);
});

test("the 30-second decode timeout terminates and reaps a stuck helper", windows, async (context) => {
  const spawn = childProcess.spawn;
  let helper;
  context.mock.method(childProcess, "spawn", () => {
    helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return helper;
  });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = decodeWindowsImage(path.resolve("stuck.heic"));
  const rejected = assert.rejects(pending, /timed out after 30 seconds/);
  await new Promise((resolve) => helper.once("spawn", resolve));
  context.mock.timers.tick(30_000);
  await rejected;
  assert.ok(helper.exitCode !== null || helper.signalCode !== null);
});

test("a decoder helper exits when its analysis-process parent dies", windows, async (context) => {
  const parent = childProcess.fork(path.join(__dirname, "unused-entry.js"), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    execArgv: ["--eval", `
      const { spawn } = require("node:child_process");
      const helper = spawn(${JSON.stringify(HELPER)}, [String(process.pid)], { stdio: ["pipe", "ignore", "ignore"] });
      helper.once("spawn", () => process.send({ pid: helper.pid }));
      process.on("disconnect", () => process.exit(0));
    `],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  context.after(() => parent.kill());
  const pid = await new Promise((resolve, reject) => {
    parent.once("message", (message) => resolve(message.pid));
    parent.once("error", reject);
  });
  context.after(() => {
    try { process.kill(pid); } catch (error) { if (error.code !== "ESRCH") throw error; }
  });
  const exited = new Promise((resolve) => parent.once("exit", resolve));
  parent.kill();
  await exited;
  await waitForProcessExit(pid);
});

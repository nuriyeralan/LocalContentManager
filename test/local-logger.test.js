"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { guardBrokenPipe, LocalLogger } = require("../src/main/local-logger");

test("ignores a broken launcher pipe and continues logging locally", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "local-content-log-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logger = new LocalLogger();
  logger.initialize(directory);
  const stream = new EventEmitter();
  guardBrokenPipe(stream, logger, "test");

  assert.doesNotThrow(() => stream.emit("error", Object.assign(new Error("broken"), { code: "EPIPE" })));
  logger.error("decode failed", new Error("unreadable image"));

  const log = fs.readFileSync(path.join(directory, "logs", "main.log"), "utf8");
  assert.match(log, /decode failed/);
  assert.match(log, /unreadable image/);
});

test("records non-EPIPE stream failures", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "local-content-stream-log-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logger = new LocalLogger();
  logger.initialize(directory);
  const stream = new EventEmitter();
  guardBrokenPipe(stream, logger, "stderr");
  stream.emit("error", Object.assign(new Error("stream failed"), { code: "EIO" }));

  const log = fs.readFileSync(path.join(directory, "logs", "main.log"), "utf8");
  assert.match(log, /stderr stream failure/);
});

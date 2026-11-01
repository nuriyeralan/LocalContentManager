"use strict";

const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");

const MAX_LOG_BYTES = 1024 * 1024;

class LocalLogger {
  constructor() {
    this.filePath = null;
    this.pendingLines = [];
  }

  initialize(userDataPath) {
    const logDirectory = path.join(userDataPath, "logs");
    const filePath = path.join(logDirectory, "main.log");
    const previousPath = path.join(logDirectory, "main.previous.log");
    fs.mkdirSync(logDirectory, { recursive: true });
    try {
      if (fs.statSync(filePath).size >= MAX_LOG_BYTES) {
        fs.rmSync(previousPath, { force: true });
        fs.renameSync(filePath, previousPath);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    this.filePath = filePath;
    if (this.pendingLines.length > 0) {
      fs.appendFileSync(this.filePath, this.pendingLines.join(""));
      this.pendingLines = [];
    }
  }

  error(context, error) {
    const details =
      error instanceof Error ? error.stack || error.message : util.inspect(error, { depth: 3 });
    const line = `${new Date().toISOString()} ERROR ${context} ${details}\n`;
    if (!this.filePath) {
      this.pendingLines.push(line);
      return;
    }
    fs.appendFileSync(this.filePath, line);
  }
}

function guardBrokenPipe(stream, logger, streamName) {
  if (!stream?.on) return;
  stream.on("error", (error) => {
    if (error.code === "EPIPE") return;
    logger.error(`${streamName} stream failure`, error);
  });
}

module.exports = { guardBrokenPipe, LocalLogger, MAX_LOG_BYTES };

"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");

class VisionAnalyzer {
  constructor(cacheDirectory) {
    this.cacheDirectory = cacheDirectory;
    this.worker = null;
    this.nextRequestId = 1;
    this.pending = new Map();
  }

  classify(images, labels, onProgress) {
    const worker = this.#ensureWorker();
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ type: "classify", id, images, labels });
    });
  }

  async dispose() {
    if (!this.worker) return;
    const worker = this.worker;
    this.worker = null;
    this.#rejectAll(new Error("The local vision worker stopped."));
    await worker.terminate();
  }

  #ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = new Worker(path.join(__dirname, "vision-worker.mjs"), {
      workerData: { cacheDirectory: this.cacheDirectory },
    });
    this.worker.on("message", (message) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.type === "progress") {
        pending.onProgress?.(message.progress);
        return;
      }
      this.pending.delete(message.id);
      if (message.type === "result") pending.resolve(message.scores);
      else pending.reject(new Error(message.error || "Local visual analysis failed."));
    });
    this.worker.on("error", (error) => {
      this.worker = null;
      this.#rejectAll(error);
    });
    this.worker.on("exit", (code) => {
      if (this.worker) this.worker = null;
      if (code !== 0) this.#rejectAll(new Error(`The local vision worker exited with code ${code}.`));
    });
    return this.worker;
  }

  #rejectAll(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}

module.exports = { VisionAnalyzer };

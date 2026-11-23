"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { analyzeImage, scanDuplicates } = require("./duplicate-scanner");

if (workerData.analyze) {
  if (workerData.method !== "exact") throw new Error("Native image decoding must run in an isolated process.");
  parentPort.on("message", async ({ index, asset }) => {
    let lastProgressAt = 0;
    try {
      const record = await analyzeImage(
        workerData.rootPath, asset, workerData.method, workerData.sensitivity,
        (fraction) => {
          const now = Date.now();
          if (fraction < 1 && now - lastProgressAt < 100) return;
          lastProgressAt = now;
          parentPort.postMessage({ type: "hashProgress", index, fraction });
        },
      );
      parentPort.postMessage({ type: "analyzed", index, record });
    } catch (error) {
      parentPort.postMessage({ type: "analyzed", index, error: error.message });
    }
  });
  parentPort.postMessage({ type: "ready" });
} else {
  scanDuplicates(workerData, (progress) => parentPort.postMessage({ type: "progress", progress }))
    .then((result) => parentPort.postMessage({ type: "result", result }))
    .catch((error) => { throw error; });
}

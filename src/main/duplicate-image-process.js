"use strict";

const { analyzeImage } = require("./duplicate-scanner");

let options;
process.on("disconnect", () => process.exit(0));
process.on("message", async (message) => {
  if (message.type === "shutdown") {
    process.disconnect();
    return;
  }
  if (message.type === "init") {
    try {
      if (message.useSharp) {
        const sharp = require("sharp");
        sharp.concurrency(1);
        sharp.cache({ memory: 16, files: 0, items: 32 });
      }
      options = message;
      process.send({ type: "ready" });
    } catch (error) {
      process.send({ type: "error", error: error.message });
    }
    return;
  }
  const { index, asset } = message;
  let lastProgressAt = 0;
  try {
    if (!options) throw new Error("The image decoder has not been initialized.");
    const record = await analyzeImage(
      options.rootPath, asset, options.method, options.sensitivity,
      (fraction) => {
        const now = Date.now();
        if (fraction < 1 && now - lastProgressAt < 100) return;
        lastProgressAt = now;
        if (process.connected) process.send({ type: "hashProgress", index, fraction });
      },
    );
    if (process.connected) process.send({ type: "analyzed", index, record });
  } catch (error) {
    if (process.connected) process.send({ type: "analyzed", index, error: error.message,
      ...(error.decoderCrash ? { kind: "decoderCrash" } : {}) });
  }
});

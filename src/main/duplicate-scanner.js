"use strict";

const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const { createReadStream } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { isWithin } = require("./media-library");
const { SAMPLE_SIZE, HashIndex, descriptorsMatch, imageDescriptors } = require("./image-similarity");
const { decodeWindowsImage, usesWindowsDecoder } = require("./windows-image-decoder");

function fingerprint(stats) {
  return [stats.size, stats.mtimeMs, stats.ctimeMs, stats.dev, stats.ino].join(":");
}

async function checkedStats(rootPath, asset) {
  const resolvedRoot = await fs.realpath(rootPath);
  const resolved = await fs.realpath(asset.absolutePath);
  const stats = await fs.lstat(asset.absolutePath);
  if (
    resolvedRoot !== rootPath || resolved !== asset.absolutePath ||
    !isWithin(rootPath, resolved) || !stats.isFile() || stats.isSymbolicLink()
  ) {
    throw new Error(`${asset.relativePath} is no longer a regular file in this library. Rescan.`);
  }
  return stats;
}

async function hashFile(filePath, progress = () => {}) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytes += chunk.length;
    progress(bytes);
  }
  return hash.digest("hex");
}

async function assertUnchanged(rootPath, record, rehash = false, onHashProgress = () => {}) {
  const stats = await checkedStats(rootPath, record.asset);
  if (fingerprint(stats) !== record.fingerprint) {
    throw new Error(`${record.asset.relativePath} changed since the scan. Rescan before recycling.`);
  }
  if (rehash && await hashFile(record.asset.absolutePath, onHashProgress) !== record.digest) {
    throw new Error(`${record.asset.relativePath} has different contents. Rescan before recycling.`);
  }
  if (fingerprint(await checkedStats(rootPath, record.asset)) !== record.fingerprint) {
    throw new Error(`${record.asset.relativePath} changed during verification. Rescan.`);
  }
}

async function decodeImage(filePath) {
  if (usesWindowsDecoder(filePath)) return decodeWindowsImage(filePath);
  const sharp = require("sharp");
  const image = sharp(filePath, { limitInputPixels: 100_000_000, animated: false });
  const metadata = await image.metadata();
  const swap = [5, 6, 7, 8].includes(metadata.orientation);
  const pixels = await image.autoOrient().flatten({ background: "#ffffff" })
    .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: "fill" }).toColourspace("srgb").removeAlpha().raw().toBuffer();
  return {
    pixels,
    width: swap ? metadata.height : metadata.width,
    height: swap ? metadata.width : metadata.height,
  };
}

function validateScanConcurrency(value = 16) {
  if (![1, 2, 4, 8, 16].includes(value)) {
    throw new Error("Choose 1, 2, 4, 8, or 16 parallel files.");
  }
  return value;
}

async function stopAnalysisWorker(lane) {
  if (!lane.isProcess) {
    await lane.worker.terminate();
    return;
  }
  if (lane.exited) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => lane.worker.kill(), 2000);
    lane.worker.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    if (lane.worker.connected) {
      lane.worker.send({ type: "shutdown" }, (error) => {
        if (error && !lane.exited) lane.worker.kill();
      });
    } else {
      lane.worker.kill();
    }
  });
}

async function analyzeImage(rootPath, asset, method, sensitivity, onHashProgress = () => {}) {
  const stats = await checkedStats(rootPath, asset);
  if (stats.size !== asset.size || stats.mtime.toISOString() !== asset.modifiedAt) {
    throw new Error("The file changed since the library scan. Rescan the library.");
  }
  const digest = await hashFile(asset.absolutePath, (bytes) =>
    onHashProgress(Math.min(1, bytes / Math.max(1, stats.size))));
  const decoded = method === "similar" ? await decodeImage(asset.absolutePath) : null;
  if (fingerprint(await checkedStats(rootPath, asset)) !== fingerprint(stats)) {
    throw new Error("The file changed while it was being analyzed.");
  }
  return {
    asset, digest, fingerprint: fingerprint(stats),
    linkedIdentity: stats.nlink > 1 ? `${stats.dev}:${stats.ino}` : null,
    width: decoded?.width ?? null, height: decoded?.height ?? null,
    descriptors: decoded ? imageDescriptors(decoded.pixels, sensitivity) : null,
  };
}

async function scanDuplicates({ rootPath, assets, method, sensitivity, concurrency = 16 }, onProgress = () => {}) {
  if (!["exact", "similar"].includes(method) || !["conservative", "broader"].includes(sensitivity)) {
    throw new Error("Choose a valid deduplication method and sensitivity.");
  }
  validateScanConcurrency(concurrency);
  const startedAt = Date.now();
  const results = new Array(assets.length);
  const errors = new Array(assets.length);
  const failures = [];
  let failed = 0;
  let decoderCrashes = 0;
  let completed = 0;
  let active = 0;
  let lastProgressAt = 0;
  function report(phase, current, total, message, force = false, fraction = 0, failure = null) {
    const now = Date.now();
    if (!force && now - lastProgressAt < 100) return;
    lastProgressAt = now;
    const ratio = total ? (current + fraction) / total : 1;
    const percent = phase === "reading" ? ratio * 80 : 80 + ratio * 20;
    onProgress({ phase, current, total, message, percent, elapsedMs: now - startedAt,
      concurrency, active, ...(failure ? { failure } : {}) });
  }
  report("reading", 0, assets.length, "Reading image contents locally...", true);
  const workers = [];
  const fractions = new Float64Array(assets.length);
  let fractionTotal = 0;
  let next = 0;
  let finished = false;
  try {
    if (assets.length) await new Promise((resolve, reject) => {
      const poolSize = Math.min(concurrency, assets.length);
      const useSharp = assets.some((asset) => !usesWindowsDecoder(asset.absolutePath));
      let readyCount = 0;
      let started = false;
      function dispatch(lane) {
        if (next >= assets.length) return;
        const index = next++;
        lane.index = index;
        active += 1;
        const message = { index, asset: assets[index] };
        if (lane.isProcess) lane.worker.send(message);
        else lane.worker.postMessage(message);
      }
      function complete(lane, record, error) {
        const index = lane.index;
        lane.index = null;
        fractionTotal -= fractions[index];
        fractions[index] = 0;
        results[index] = record;
        errors[index] = error;
        completed += 1;
        if (completed === assets.length) fractionTotal = 0;
        active -= 1;
        if (!lane.exited) dispatch(lane);
        report("reading", completed, assets.length,
          `Read ${completed} of ${assets.length} images; ${active} files in parallel.`,
          completed === assets.length, Math.max(0, fractionTotal));
        if (error?.kind === "decoderCrash") {
          decoderCrashes += 1;
          const failure = { path: assets[index].relativePath, ...error };
          report("reading", completed, assets.length, error.error, true,
            Math.max(0, fractionTotal), failure);
        }
        if (completed === assets.length) {
          finished = true;
          resolve();
        }
      }
      function startLane() {
        const isProcess = method === "similar";
        const worker = isProcess
          ? childProcess.fork(path.join(__dirname, "duplicate-image-process.js"), [], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            execArgv: [],
            serialization: "advanced", windowsHide: true,
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          })
          : new Worker(path.join(__dirname, "duplicate-worker.js"), {
            workerData: { analyze: true, rootPath, method, sensitivity },
          });
        const lane = { worker, isProcess, index: null, ready: false, exited: false, stderr: "" };
        workers.push(lane);
        const startupTimer = setTimeout(() => {
          reject(new Error("An image analysis worker did not become ready within 30 seconds."));
        }, 30_000);
        worker.stderr?.on("data", (chunk) => {
          lane.stderr = (lane.stderr + chunk.toString()).slice(-4096);
        });
        worker.on("message", (message) => {
          if (finished) return;
          if (message.type === "ready") {
            clearTimeout(startupTimer);
            lane.ready = true;
            if (started) {
              dispatch(lane);
            } else if (++readyCount === poolSize) {
              started = true;
              for (const ready of workers) dispatch(ready);
              report("reading", 0, assets.length, `Analyzing up to ${active} files in parallel...`, true);
            }
            return;
          }
          if (message.type === "error") {
            reject(new Error(message.error));
            return;
          }
          const { index } = message;
          if (index !== lane.index) {
            reject(new Error("An image analysis worker returned an unexpected file."));
            return;
          }
          if (message.type === "hashProgress") {
            const fraction = message.fraction * (method === "similar" ? 0.8 : 0.95);
            fractionTotal += fraction - fractions[index];
            fractions[index] = fraction;
            report("reading", completed, assets.length,
              `Analyzing ${assets[index].relativePath}; ${active} files in parallel...`, false, fractionTotal);
            return;
          }
          if (message.type !== "analyzed") return;
          complete(lane, message.record, message.error
            ? { error: message.error, ...(message.kind ? { kind: message.kind } : {}) }
            : null);
        });
        worker.once("error", (error) => {
          clearTimeout(startupTimer);
          reject(error);
        });
        worker.once("exit", (code, signal) => {
          clearTimeout(startupTimer);
          lane.exited = true;
          if (finished) return;
          const reason = `exit ${code ?? signal ?? "unknown"}${lane.stderr ? `: ${lane.stderr.trim()}` : ""}`;
          if (!isProcess || !lane.ready) {
            reject(new Error(`An image analysis worker stopped unexpectedly (${reason}).`));
            return;
          }
          if (lane.index !== null) {
            const failure = {
              path: assets[lane.index].relativePath,
              error: `Native image decoder exited unexpectedly (${reason}). This file was skipped and left untouched.`,
              kind: "decoderCrash",
            };
            complete(lane, null, failure);
          }
          if (!finished && next < assets.length) startLane();
        });
        if (isProcess) worker.send({ type: "init", rootPath, method, sensitivity, useSharp });
      }
      for (let slot = 0; slot < poolSize; slot += 1) {
        startLane();
      }
    });
  } finally {
    finished = true;
    await Promise.all(workers.map(stopAnalysisWorker));
  }
  for (let index = 0; index < errors.length; index += 1) {
    if (errors[index]) {
      failed += 1;
      if (failures.length < 50) failures.push({ path: assets[index].relativePath, ...errors[index] });
    }
  }
  const records = results.filter(Boolean);
  records.sort((a, b) =>
    (b.width * b.height - a.width * a.height) || b.asset.size - a.asset.size ||
    a.asset.relativePath.localeCompare(b.asset.relativePath));
  const groups = [];
  const byDigest = new Map();
  const fullIndex = new HashIndex();
  const cropIndex = new HashIndex();
  report("comparing", 0, records.length, "Comparing image fingerprints...", true);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    let group = byDigest.get(record.digest);
    if (!group && record.descriptors) {
      const candidates = new Set();
      const visit = (query) => ({ descriptor, group: candidate }) => {
        report("comparing", index, records.length, `Comparing ${index + 1} of ${records.length} images...`);
        if (descriptorsMatch(query, descriptor, sensitivity)) candidates.add(candidate);
      };
      const radius = sensitivity === "broader" ? 10 : 6;
      fullIndex.find(record.descriptors.full, radius, visit(record.descriptors.full));
      cropIndex.find(record.descriptors.full, radius, visit(record.descriptors.full));
      for (const crop of record.descriptors.crops) fullIndex.find(crop, radius, visit(crop));
      group = [...candidates].sort((a, b) => a.order - b.order)[0];
    }
    if (!group) {
      group = { id: record.asset.id, order: groups.length, memberIds: [] };
      groups.push(group);
      if (record.descriptors) {
        if (record.descriptors.full.textured) {
          fullIndex.add({ descriptor: record.descriptors.full, group });
        }
        for (const crop of record.descriptors.crops) {
          if (crop.textured) cropIndex.add({ descriptor: crop, group });
        }
      }
    }
    group.memberIds.push(record.asset.id);
    // Only the group's anchor is indexed: similarity chains do not merge unrelated endpoints.
    byDigest.set(record.digest, group);
    report("comparing", index + 1, records.length, `Compared ${index + 1} of ${records.length} images.`, index + 1 === records.length);
  }
  report("comparing", records.length, records.length, "Scan complete. Review before recycling.", true);
  return {
    method, sensitivity, concurrency, scanned: assets.length, analyzed: records.length,
    failed, failures, decoderCrashes,
    groups: groups.filter((group) => group.memberIds.length > 1),
    records: records.map(({ descriptors: _descriptors, ...record }) => record),
  };
}

module.exports = {
  analyzeImage, assertUnchanged, checkedStats, decodeImage, fingerprint, hashFile,
  scanDuplicates, validateScanConcurrency,
};

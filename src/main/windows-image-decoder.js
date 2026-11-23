"use strict";

const childProcess = require("node:child_process");
const path = require("node:path");
const { SAMPLE_SIZE } = require("./image-similarity");

const HELPER_PATH = path.join(__dirname, "..", "..", ".runtime", "wic", "WindowsImageDecoder.exe");
const HEADER_BYTES = 20;
const PIXEL_BYTES = SAMPLE_SIZE * SAMPLE_SIZE * 3;
const MAX_RESPONSE_BYTES = HEADER_BYTES + PIXEL_BYTES;
const WINDOWS_IMAGE_EXTENSIONS = new Set([".heic", ".heif"]);

function usesWindowsDecoder(filePath) {
  return WINDOWS_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function parseResponse(buffer) {
  if (buffer.length < HEADER_BYTES || buffer.toString("ascii", 0, 4) !== "LCW1") {
    throw new Error("The Windows image decoder returned an invalid response.");
  }
  const status = buffer.readInt32LE(4);
  const width = buffer.readInt32LE(8);
  const height = buffer.readInt32LE(12);
  const length = buffer.readInt32LE(16);
  if (length < 0 || buffer.length !== HEADER_BYTES + length) {
    throw new Error("The Windows image decoder returned an invalid payload length.");
  }
  if (status === 1) {
    const hresult = `0x${(width >>> 0).toString(16).padStart(8, "0")}`;
    const details = buffer.toString("utf8", HEADER_BYTES);
    const codecHelp = [0x88982f50, 0x88982f07, 0x88982f80, 0x88982f81].includes(width >>> 0)
      ? " Verify this file is readable and install or update HEIF Image Extensions and an HEVC decoder, such as Microsoft HEVC Video Extensions, if required."
      : "";
    throw new Error(`Windows full-image decoding failed (${hresult}): ${details}${codecHelp}`);
  }
  if (status !== 0 || length !== PIXEL_BYTES || width <= 0 || height <= 0 || width * height > 100_000_000) {
    throw new Error("The Windows image decoder returned invalid dimensions or RGB pixels.");
  }
  return { width, height, pixels: buffer.subarray(HEADER_BYTES) };
}

async function decodeWindowsImage(filePath) {
  if (process.platform !== "win32") throw new Error("HEIC/HEIF spectral decoding requires Windows and its HEIF/HEVC codecs.");
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error("Windows image decoding requires an absolute image path.");
  }
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(HELPER_PATH, [String(process.pid)], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    let bytes = 0;
    let stderr = "";
    let inputError;
    let failure;
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error("Windows full-image decoding timed out after 30 seconds; the file was left untouched."));
    }, 30_000);
    function fail(error) {
      if (settled || failure) return;
      failure = error;
      clearTimeout(timer);
      child.kill();
    }
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        fail(new Error("The Windows image decoder exceeded its output limit."));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    child.stdin.on("error", (error) => { inputError = error; });
    child.once("error", (error) => {
      fail(error.code === "ENOENT"
        ? new Error("The Windows image decoder helper is missing. Reinstall the app; developers can run npm run build:decoder.")
        : error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        const error = new Error(`Windows image decoder exited unexpectedly (${code ?? signal ?? "unknown"})` +
          `${stderr ? `: ${stderr.trim()}` : ""}. The file was left untouched.`);
        error.decoderCrash = true;
        reject(error);
        return;
      }
      try {
        if (inputError) throw inputError;
        resolve(parseResponse(Buffer.concat(chunks, bytes)));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(`${Buffer.from(filePath, "utf8").toString("base64")}\n`);
  });
}

module.exports = { decodeWindowsImage, parseResponse, usesWindowsDecoder };

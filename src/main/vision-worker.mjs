import { parentPort, workerData } from "node:worker_threads";
import { env, pipeline, RawImage } from "@huggingface/transformers";
import visionConstants from "./vision-constants.js";

const { MODEL_ID, MODEL_REVISION } = visionConstants;

env.cacheDir = workerData.cacheDirectory;
env.allowRemoteModels = true;

let classifierPromise;

function classifierFor(requestId) {
  if (!classifierPromise) {
    classifierPromise = pipeline("zero-shot-image-classification", MODEL_ID, {
      device: "cpu",
      dtype: "q8",
      revision: MODEL_REVISION,
      progress_callback: (progress) => {
        parentPort.postMessage({
          type: "progress",
          id: requestId,
          progress: {
            status: progress.status,
            file: progress.file,
            progress: Number.isFinite(progress.progress) ? progress.progress : null,
          },
        });
      },
    });
  }
  return classifierPromise;
}

parentPort.on("message", async (message) => {
  if (message.type !== "classify") return;
  try {
    const classifier = await classifierFor(message.id);
    const images = message.images.map(
      (image) => new RawImage(new Uint8Array(image.pixels), image.width, image.height, 4),
    );
    const output = await classifier(images, message.labels);
    const batches = images.length === 1 && !Array.isArray(output[0]) ? [output] : output;
    const scores = batches.map((results) =>
      message.labels.map((label) => results.find((result) => result.label === label)?.score ?? 0),
    );
    parentPort.postMessage({ type: "result", id: message.id, scores });
  } catch (error) {
    parentPort.postMessage({
      type: "error",
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

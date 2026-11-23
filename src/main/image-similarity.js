"use strict";

const SAMPLE_SIZE = 96;
const HASH_SIZE = 32;
const COSINES = Array.from({ length: 8 }, (_, frequency) =>
  Array.from({ length: HASH_SIZE }, (_, index) =>
    Math.cos(((2 * index + 1) * frequency * Math.PI) / (2 * HASH_SIZE))),
);

function hamming(left, right) {
  let bits = left ^ right;
  let count = 0;
  while (bits) {
    bits &= bits - 1n;
    count += 1;
  }
  return count;
}

function descriptor(pixels, x, y, width, height) {
  const luminance = new Float64Array(HASH_SIZE * HASH_SIZE);
  const color = [0, 0, 0];
  let squared = 0;
  let mean = 0;
  for (let row = 0; row < HASH_SIZE; row += 1) {
    for (let column = 0; column < HASH_SIZE; column += 1) {
      const startX = Math.floor(x + (column * width) / HASH_SIZE);
      const endX = Math.max(startX + 1, Math.floor(x + ((column + 1) * width) / HASH_SIZE));
      const startY = Math.floor(y + (row * height) / HASH_SIZE);
      const endY = Math.max(startY + 1, Math.floor(y + ((row + 1) * height) / HASH_SIZE));
      const rgb = [0, 0, 0];
      let count = 0;
      for (let py = startY; py < endY; py += 1) {
        for (let px = startX; px < endX; px += 1) {
          const offset = (py * SAMPLE_SIZE + px) * 3;
          for (let channel = 0; channel < 3; channel += 1) rgb[channel] += pixels[offset + channel];
          count += 1;
        }
      }
      for (let channel = 0; channel < 3; channel += 1) {
        rgb[channel] /= count;
        color[channel] += rgb[channel] / luminance.length;
      }
      const value = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
      luminance[row * HASH_SIZE + column] = value;
      mean += value / luminance.length;
      squared += (value * value) / luminance.length;
    }
  }
  const horizontal = new Float64Array(HASH_SIZE * 8);
  for (let row = 0; row < HASH_SIZE; row += 1) {
    for (let u = 0; u < 8; u += 1) {
      for (let column = 0; column < HASH_SIZE; column += 1) {
        horizontal[row * 8 + u] += luminance[row * HASH_SIZE + column] * COSINES[u][column];
      }
    }
  }
  const coefficients = [];
  for (let v = 0; v < 8; v += 1) {
    for (let u = 0; u < 8; u += 1) {
      if (u === 0 && v === 0) continue;
      let value = 0;
      for (let row = 0; row < HASH_SIZE; row += 1) {
        value += horizontal[row * 8 + u] * COSINES[v][row];
      }
      coefficients.push(value);
    }
  }
  const median = [...coefficients].sort((a, b) => a - b)[31];
  let hash = 0n;
  coefficients.forEach((value, index) => {
    if (value > median) hash |= 1n << BigInt(index);
  });
  return { hash, color, textured: Math.sqrt(Math.max(0, squared - mean * mean)) >= 8 };
}

function imageDescriptors(pixels, sensitivity) {
  if (pixels.length !== SAMPLE_SIZE * SAMPLE_SIZE * 3) {
    throw new Error("The image decoder returned an invalid RGB sample.");
  }
  const full = descriptor(pixels, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const crops = [];
  const scales = sensitivity === "broader" ? [0.9, 0.75, 0.6] : [0.9];
  for (const scale of scales) {
    const side = Math.round(SAMPLE_SIZE * scale);
    const edge = SAMPLE_SIZE - side;
    for (const [x, y] of [[edge / 2, edge / 2], [0, 0], [edge, 0], [0, edge], [edge, edge]]) {
      crops.push(descriptor(pixels, x, y, side, side));
    }
  }
  return { full, crops };
}

function descriptorsMatch(left, right, sensitivity) {
  const threshold = sensitivity === "broader" ? 10 : 6;
  const colorLimit = sensitivity === "broader" ? 30 : 20;
  return left.textured && right.textured &&
    hamming(left.hash, right.hash) <= threshold &&
    left.color.reduce((sum, value, index) => sum + Math.abs(value - right.color[index]), 0) / 3 <= colorLimit;
}

class HashIndex {
  constructor() {
    this.root = null;
  }

  add(value) {
    const node = { hash: value.descriptor.hash, values: [value], children: new Map() };
    if (!this.root) {
      this.root = node;
      return;
    }
    let current = this.root;
    while (true) {
      const distance = hamming(node.hash, current.hash);
      if (distance === 0) {
        current.values.push(value);
        return;
      }
      const child = current.children.get(distance);
      if (!child) {
        current.children.set(distance, node);
        return;
      }
      current = child;
    }
  }

  find(descriptor, radius, visit) {
    if (!this.root || !descriptor.textured) return;
    const pending = [this.root];
    while (pending.length) {
      const node = pending.pop();
      const distance = hamming(descriptor.hash, node.hash);
      if (distance <= radius) {
        for (const value of node.values) visit(value);
      }
      for (const [edge, child] of node.children) {
        if (edge >= distance - radius && edge <= distance + radius) pending.push(child);
      }
    }
  }
}

module.exports = { SAMPLE_SIZE, HashIndex, descriptorsMatch, hamming, imageDescriptors };

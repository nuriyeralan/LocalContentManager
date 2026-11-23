"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "deduplication.js"), "utf8");

class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.hiddenClasses = new Set();
    this.classList = {
      add: (value) => this.hiddenClasses.add(value),
      remove: (value) => this.hiddenClasses.delete(value),
      toggle: (value, enabled) => enabled ? this.hiddenClasses.add(value) : this.hiddenClasses.delete(value),
    };
  }
  addEventListener(event, handler) { this.listeners[event] = handler; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
}

function fixture(api = {}, groupCount = 1) {
  const elements = new Map();
  const events = [];
  const context = vm.createContext({
    window: {
      localContent: { onDeduplicationProgress() {}, cancelDeduplication: async () => ({ ok: true }), ...api },
      dispatchEvent: (event) => events.push(event),
    },
    document: {
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      },
      createElement: () => new Element(),
    },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  });
  vm.runInContext(source, context);
  const state = vm.runInContext("dedupState", context);
  elements.get("deduplication-method").value = "exact";
  elements.get("deduplication-sensitivity").value = "conservative";
  elements.get("deduplication-concurrency").value = "16";
  state.plan = {
    id: "plan",
    method: "similar",
    groups: Array.from({ length: groupCount }, (_, groupIndex) => ({
      id: `group-${groupIndex}`,
      members: ["canonical", "copy", "other"].map((kind) => ({
        id: `${kind}-${groupIndex}`,
        name: `${kind}-${groupIndex}.png`,
        relativePath: `${kind}-${groupIndex}.png`,
        size: 1024,
        modifiedAt: "2026-01-01T00:00:00.000Z",
        width: 640,
        height: 480,
      })),
    })),
  };
  state.library = { recycleBinRoot: "recycle" };
  return {
    context, elements, state, events,
    run: (code) => vm.runInContext(code, context),
    element: (id) => elements.get(id),
  };
}

test("renders 20 duplicate groups per page with every group contained in one row", () => {
  const ui = fixture({}, 45);
  ui.run("renderDedupReview()");
  assert.equal(ui.element("deduplication-groups").children.length, 20);
  assert.equal(ui.element("deduplication-page-summary").textContent, "Groups 1-20 of 45");
  assert.equal(ui.element("deduplication-previous").disabled, true);
  assert.equal(ui.element("deduplication-next").disabled, false);
  assert.equal(ui.element("deduplication-groups").children[0].children[1].children.length, 3);
  ui.run("dedupState.page = 2; renderDedupReview()");
  assert.equal(ui.element("deduplication-groups").children.length, 5);
  assert.equal(ui.element("deduplication-page-summary").textContent, "Groups 41-45 of 45");
});

test("one keeper choice automatically treats every sibling as a recycle candidate", () => {
  const ui = fixture();
  ui.run('chooseDedupKeeper("group-0", "canonical-0")');
  const choice = ui.run("selectedDedupChoices()[0]");
  assert.equal(choice.groupId, "group-0");
  assert.equal(choice.keeperId, "canonical-0");
  const cards = ui.element("deduplication-groups").children[0].children[1].children;
  assert.match(cards[0].className, /keeper/);
  assert.match(cards[1].className, /recycle/);
  assert.match(cards[2].className, /recycle/);
  assert.equal(ui.element("accept-deduplication-choices").disabled, false);
  assert.match(ui.element("deduplication-choice-summary").textContent, /1 reviewed group.*2 images will be recycled/);
});

test("unreviewed groups retain all images and create no recycling choices", () => {
  const ui = fixture({}, 2);
  ui.run("renderDedupReview()");
  assert.equal(ui.run("selectedDedupChoices().length"), 0);
  assert.equal(ui.element("accept-deduplication-choices").disabled, true);
  assert.match(ui.element("deduplication-choice-summary").textContent, /retain every image/);
  for (const row of ui.element("deduplication-groups").children) {
    assert.match(row.children[0].children[1].textContent, /Not reviewed - retain all 3/);
  }
});

test("choices persist across pages and Accept choices submits all reviewed groups once", async () => {
  let submitted;
  const remainingPlan = { id: "plan", groups: [{ id: "unreviewed", members: [] }] };
  const snapshot = { assets: [{ id: "retained" }], recycleBinRoot: "recycle" };
  const ui = fixture({
    recycleDuplicates: async (planId, choices) => {
      submitted = { planId, choices };
      return {
        ok: true,
        data: {
          status: "complete",
          moved: [{ assetId: "copy-0" }, { assetId: "other-0" }, { assetId: "copy-20" }, { assetId: "other-20" }],
          processedGroupIds: ["group-0", "group-20"],
          plan: remainingPlan,
          state: snapshot,
        },
      };
    },
  }, 21);
  ui.run('chooseDedupKeeper("group-0", "canonical-0"); dedupState.page = 1; chooseDedupKeeper("group-20", "canonical-20")');
  await ui.run("acceptDedupChoices()");
  assert.equal(submitted.planId, "plan");
  assert.equal(submitted.choices.length, 2);
  assert.deepEqual(
    Array.from(submitted.choices, (choice) => choice.groupId).sort(),
    ["group-0", "group-20"],
  );
  assert.equal(ui.state.choices.size, 0);
  assert.equal(ui.state.plan, remainingPlan);
  assert.equal(ui.events[0].detail, snapshot);
  assert.match(ui.element("deduplication-status").textContent, /Accepted 2 groups and recycled 4 images/);
});

test("Accept choices remains disabled without a recycling folder", () => {
  const ui = fixture();
  ui.state.library.recycleBinRoot = null;
  ui.run('chooseDedupKeeper("group-0", "canonical-0")');
  assert.equal(ui.element("accept-deduplication-choices").disabled, true);
  assert.match(ui.element("deduplication-recycle-path").textContent, /never permanently deletes/);
});

test("partial errors refresh the library, discard stale results, and remain visible", async () => {
  const snapshot = { assets: [{ id: "canonical-0" }] };
  const ui = fixture({
    recycleDuplicates: async () => ({
      ok: true,
      data: {
        status: "error",
        moved: [{ assetId: "copy-0" }],
        processedGroupIds: [],
        plan: null,
        error: "Share became read-only.",
        state: snapshot,
      },
    }),
  });
  ui.run('chooseDedupKeeper("group-0", "canonical-0")');
  await ui.run("acceptDedupChoices()");
  assert.equal(ui.state.plan, null);
  assert.equal(ui.state.busy, null);
  assert.equal(ui.state.choices.size, 0);
  assert.match(ui.element("deduplication-status").textContent, /Stopped after recycling 1 copy.*read-only.*Scan again/);
  assert.equal(ui.events[0].detail, snapshot);
});

test("scan failures clear old results and leave persistent errors rather than success-shaped output", async () => {
  const ui = fixture({ scanDuplicates: async () => ({ ok: false, error: "Worker stopped unexpectedly." }) });
  await ui.run("scanDedupImages({ preventDefault() {} })");
  assert.equal(ui.state.plan, null);
  assert.equal(ui.state.busy, null);
  assert.equal(ui.element("deduplication-status").className, "goal-status error");
  assert.match(ui.element("deduplication-status").textContent, /Worker stopped/);
});

test("submits the selected file concurrency and disables it during scans", async () => {
  let submitted;
  let finish;
  const ui = fixture({ scanDuplicates: (...args) => {
    submitted = args;
    return new Promise((resolve) => { finish = resolve; });
  } });
  ui.element("deduplication-concurrency").value = "8";
  const scanning = ui.run("scanDedupImages({ preventDefault() {} })");
  assert.deepEqual(submitted, ["exact", "conservative", 8]);
  assert.equal(ui.element("deduplication-concurrency").disabled, true);
  finish({ ok: true, data: { groups: [], analyzed: 0, scanned: 0, failed: 0, method: "exact" } });
  await scanning;
  assert.equal(ui.element("deduplication-concurrency").disabled, false);
});

test("native decoder failures are visible with their file paths and are never selected for recycling", async () => {
  const ui = fixture({
    scanDuplicates: async () => ({ ok: true, data: {
      groups: [], method: "similar", scanned: 1, analyzed: 0, failed: 1, decoderCrashes: 1,
      failures: [{ path: "problem.tif", error: "Native image decoder exited unexpectedly (exit 77)." }],
    } }),
  });
  await ui.run("scanDedupImages({ preventDefault() {} })");
  assert.match(ui.element("deduplication-status").textContent, /1 native decoder failure.*left untouched/);
  assert.match(ui.element("deduplication-status").textContent, /No images could be analyzed/);
  assert.equal(ui.element("deduplication-status").className, "goal-status error");
  assert.match(ui.element("deduplication-failure-list").children[0].textContent, /problem.tif.*exit 77/);
  assert.equal(ui.run("selectedDedupChoices().length"), 0);
  assert.equal(ui.element("deduplication-concurrency").disabled, false);
});

test("deduplication offers 1/2/4/8/16 parallel files and defaults to 16", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  const select = html.match(/<select id="deduplication-concurrency">([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...select.matchAll(/value="(\d+)"/g)].map((match) => Number(match[1])), [1, 2, 4, 8, 16]);
  assert.match(select, /value="16" selected/);
  assert.doesNotMatch(html, /id="open-organizer"|Organize with agent/);
});

test("Escape closes only the enlarged preview and busy operations cannot close the review", async () => {
  let closed = 0;
  const ui = fixture({ cancelDeduplication: async () => { closed += 1; return { ok: true }; } });
  ui.element("deduplication-preview").open = true;
  ui.element("deduplication-dialog").open = true;
  let prevented = false;
  let stopped = false;
  ui.element("deduplication-preview").listeners.keydown({
    key: "Escape",
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
  });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(ui.element("deduplication-preview").open, false);
  assert.equal(ui.element("deduplication-dialog").open, true);
  ui.run('setDedupBusy("recycling")');
  await ui.run("closeDeduplication()");
  assert.equal(closed, 0);
  assert.equal(ui.element("deduplication-dialog").open, true);
  ui.run("setDedupBusy(null)");
  await ui.run("closeDeduplication()");
  assert.equal(closed, 1);
  assert.equal(ui.element("deduplication-dialog").open, false);
});

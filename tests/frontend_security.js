"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
require("./frontend_recovery.js");
require("./frontend_pai_estimate.js");
require("./frontend_pai_quota_quality.js");

const componentsSource = fs.readFileSync(
  path.join(__dirname, "..", "web", "js", "components.js"),
  "utf8",
);
const rankingSource = fs.readFileSync(
  path.join(__dirname, "..", "web", "js", "ranking.js"),
  "utf8",
);
const appSource = fs.readFileSync(
  path.join(__dirname, "..", "web", "js", "app.js"),
  "utf8",
);
const overviewSource = fs.readFileSync(
  path.join(__dirname, "..", "web", "js", "overview.js"),
  "utf8",
);
const clusterSource = fs.readFileSync(
  path.join(__dirname, "..", "web", "js", "cluster.js"),
  "utf8",
);
const hostSource = fs.readFileSync(
  path.join(__dirname, "..", "web", "js", "host.js"),
  "utf8",
);
const i18nSource = fs.readFileSync(
  path.join(__dirname, "..", "web", "js", "i18n.js"),
  "utf8",
);
const echarts = require(path.join(__dirname, "..", "web", "vendor", "echarts.min.js"));

const context = { window: {} };
vm.createContext(context);
vm.runInContext(componentsSource, context);
vm.runInContext(i18nSource, context);

assert.equal(
  context.window.UI.escapeHtml(`<img src=x onerror="alert('x')"> &`),
  "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp;",
);
assert.equal(context.window.UI.escapeHtml(null), "");
assert.match(rankingSource, /escapeHtml\(x\.name\)/);
assert.doesNotMatch(rankingSource, /\$\{x\.name\}/);
assert.doesNotMatch(appSource, /\$\{e\.message\}/);
assert.equal(echarts.version, "6.1.0");

const i18n = context.window.I18n;
assert.equal(i18n.localize("legacy", "fr"), "legacy");
assert.equal(i18n.localize({ zh: "中文", en: "English" }, "en"), "English");
assert.equal(i18n.localize({ zh: "中文", en: "English" }, "fr"), "中文");
assert.equal(i18n.localize({ en: "English", zh: "中文" }, "fr"), "English");
assert.equal(i18n.localize({ en: "Only translation" }, "fr"), "Only translation");
assert.equal(i18n.localize({ zh: "简体" }, "zh-CN"), "简体");
assert.equal(i18n.localize({ "zh-CN": "简体" }, "zh"), "简体");
assert.equal(i18n.localize(null, "zh"), "");
assert.match(componentsSource, /I18n\.localize\(b\.text_i18n \?\? b\.text\)/);
assert.match(componentsSource, /I18n\.localize\(b\.tooltip_i18n \?\? b\.tooltip\)/);
assert.match(overviewSource, /I18n\.localize\(group\.description_i18n \?\? group\.description\)/);
assert.match(overviewSource, /I18n\.localize\(c\.note_i18n \?\? c\.note\)/);
assert.match(overviewSource, /I18n\.localize\(h\.note_i18n \?\? h\.note\)/);
assert.match(clusterSource, /I18n\.localize\(c\.note_i18n \?\? c\.note\)/);
assert.match(hostSource, /I18n\.localize\(host\.note_i18n \?\? host\.note\)/);

// Exercise rendered card labels, including zero, instead of matching JS source.
context.I18n = i18n;
context.document = {
  body: { dataset: {} },
  createTextNode(text) { return { textContent: text }; },
  createElement() {
    return {
      children: [], style: {},
      appendChild(child) { this.children.push(child); },
      setAttribute(key, value) { this[key] = value; },
      addEventListener() {},
      get textContent() { return this.children.map(child => child.textContent).join(""); },
    };
  },
};
const cardText = (card, cls) => card.children.find(child => child.className?.split(" ").includes(cls))?.textContent;
const host = { health: "gpu_error", online: true, last_ok_ts: 1000, gpu_poll_interval_s: 60 };
const gpu = { index: 0, now: null, util_recent: null, avg: 42, users: [],
  last_sample: { ts: 1000, util_gpu: 80, util_recent: 75 } };
for (const locale of ["zh", "en"]) {
  i18n.locale = locale;
  const previous = context.window.UI.gpuCard(gpu, { host });
  assert.equal(cardText(previous, "now"), "75");
  assert.equal(cardText(previous, "avg"), i18n.t("avg") + " 42");
  assert.ok(previous.className.split(" ").includes("degraded"));
  assert.match(previous.title, /80%/);
  assert.ok(previous.title.includes(context.window.UI.ago(1000)));
  for (const value of [0, 100]) {
    const card = context.window.UI.gpuCard({ ...gpu, last_sample: { ...gpu.last_sample, util_recent: value } }, { host });
    assert.equal(cardText(card, "now"), String(value));
    assert.equal(cardText(card, "avg"), i18n.t("avg") + " 42");
  }
  const expired = context.window.UI.gpuCard({ ...gpu, last_sample: { ...gpu.last_sample, util_recent: null } }, { host });
  assert.equal(cardText(expired, "now"), i18n.t("gpu_delayed_short"));
  for (const health of ["offline", "unknown"]) {
    const card = context.window.UI.gpuCard(gpu, { host: { ...host, health, online: false } });
    assert.equal(cardText(card, "now"), i18n.t(health === "offline" ? "offline" : "unknown_short"));
    assert.equal(cardText(card, "avg"), health === "offline" ? undefined : i18n.t("avg") + " 42");
  }
  const recovered = context.window.UI.gpuCard({ ...gpu, now: { util_gpu: 12 }, util_recent: 20 }, { host });
  assert.equal(cardText(recovered, "now"), "20");
  assert.equal(cardText(recovered, "avg"), i18n.t("avg") + " 42");
  const aging = context.window.UI.gpuCard(gpu, { host: { ...host, health: "online" } });
  assert.ok(aging.className.split(" ").includes("degraded"));
  assert.equal(cardText(aging, "avg"), i18n.t("avg") + " 42");
}

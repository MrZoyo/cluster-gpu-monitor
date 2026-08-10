"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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

const context = { window: {} };
vm.createContext(context);
vm.runInContext(componentsSource, context);

assert.equal(
  context.window.UI.escapeHtml(`<img src=x onerror="alert('x')"> &`),
  "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp;",
);
assert.equal(context.window.UI.escapeHtml(null), "");
assert.match(rankingSource, /escapeHtml\(x\.name\)/);
assert.doesNotMatch(rankingSource, /\$\{x\.name\}/);
assert.doesNotMatch(appSource, /\$\{e\.message\}/);

// Dependency-free fallback tests; also run by frontend_security.js in CI.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/js/recovery.js"), "utf8");

function setup(platform, locale = "zh", ready = true) {
  const events = {}, domEvents = {}, nodes = [];
  const body = { prepend: n => nodes.unshift(n) };
  const document = {
    body: ready ? body : null, documentElement: { lang: locale },
    createElement: () => ({ setAttribute(k, v) { this[k] = v; } }),
    getElementById: id => nodes.find(n => n.id === id),
    addEventListener: (name, cb) => { domEvents[name] = cb; },
  };
  const context = vm.createContext({ navigator: { platform }, document });
  context.window = context;
  context.addEventListener = (name, cb) => { events[name] = cb; };
  vm.runInContext(source, context);
  return { context, events, domEvents, nodes, body };
}
for (const [platform, shortcut] of [["MacIntel", "Command+Shift+R"], ["Win32", "Ctrl+Shift+R"], ["Linux x86_64", "Ctrl+Shift+R"]]) {
  const s = setup(platform);
  assert.equal(s.nodes.length, 0);
  s.events.error({ target: { tagName: "IMG" } });
  assert.equal(s.nodes.length, 0, "Missing icons must not trigger recovery");
  s.events.error({ target: { tagName: "SCRIPT" } });
  s.events.unhandledrejection({ reason: "<script>private error</script>" });
  assert.equal(s.nodes.length, 1, "Repeated errors must not flood the page");
  assert.equal(s.nodes[0].role, "alert");
  assert.ok(s.nodes[0].textContent.includes(shortcut));
  assert.ok(s.nodes[0].textContent.includes("联系管理员"));
  assert.ok(!s.nodes[0].textContent.includes("private error"));
}
const early = setup("Win32", "en", false);
early.events.error({ target: { tagName: "LINK", rel: "stylesheet" } });
early.context.document.body = early.body;
early.domEvents.DOMContentLoaded();
assert.match(early.nodes[0].textContent, /contact your administrator/);
early.context.I18n = { getLocale: () => "zh" };
early.context.PageRecovery.show();
assert.match(early.nodes[0].textContent, /网页可能已经更新/);
early.context.I18n = {};
early.context.PageRecovery.show();
assert.match(early.nodes[0].textContent, /contact your administrator/);
const index = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
assert.ok(index.indexOf("/js/recovery.js") < index.indexOf("/vendor/echarts"));
console.log("Frontend recovery checks passed (OS, language, early assets, async errors, deduplication).");

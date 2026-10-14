// Reconcile a completed background render; never clear the live view while fetching.
window.LiveDOM = (() => {
  // New event handlers carry fresh data. Captured DOM containers use UI.live()
  // to reach retained nodes; event.currentTarget already refers to the live node.
  const aliases = new WeakMap();
  const live = node => { while (aliases.has(node)) node = aliases.get(node); return node; };
  const draft = node => node?.closest?.('[data-refresh-draft]');
  const signature = option => JSON.stringify(option, (_, value) => typeof value === 'function' ? value.toString() : value);

  function chart(dom) {
    dom.setAttribute('data-refresh-chart', '');
    if (draft(dom)) {
      const pending = { option: null, setOption(option) { this.option = option; }, resize() {}, dispose() {}, getDom: () => dom, _draft: true };
      dom._pendingChart = pending;
      return pending;
    }
    const instance = echarts.init(dom), setOption = instance.setOption.bind(instance);
    instance.setOption = (option, ...args) => { dom._chartSignature = signature(option); return setOption(option, ...args); };
    return instance;
  }

  function updateChart(node, pending) {
    let instance = echarts.getInstanceByDom(node);
    if (!instance) { instance = chart(node); GM.onResize(instance); }
    if (node._chartSignature !== signature(pending.option)) {
      instance.setOption(pending.option, { replaceMerge: ['series'], lazyUpdate: true });
    }
    delete node._pendingChart;
  }

  function dispose(node) {
    if (node.nodeType !== 1) return;
    for (const dom of [node, ...node.querySelectorAll('[data-refresh-chart]')]) echarts.getInstanceByDom(dom)?.dispose();
  }

  function key(node) {
    if (node.nodeType !== 1) return null;
    return node.getAttribute('data-refresh-key') || (node.id ? 'id:' + node.id : null);
  }
  function compatible(a, b) {
    if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
    if (key(a) || key(b)) return key(a) === key(b);
    // Distinguish optional warnings, headers and sections without using changing values.
    return a.nodeType !== 1 || a.classList[0] === b.classList[0];
  }
  function events(node, next) {
    for (const [type, fn] of Object.entries(node._uiEvents || {})) node.removeEventListener(type, fn);
    node._uiEvents = next._uiEvents || {};
    for (const [type, fn] of Object.entries(node._uiEvents)) node.addEventListener(type, fn);
  }
  function patch(node, next) {
    aliases.set(next, node);
    if (node.nodeType !== 1) {
      if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
      return;
    }
    const oldChart = node.hasAttribute('data-refresh-chart') && echarts.getInstanceByDom(node);
    const preserve = name => name === 'data-refresh-draft' || name === '_echarts_instance_' ||
      (node.tagName === 'DETAILS' && name === 'open') || name === 'aria-expanded';
    for (const attr of [...node.attributes]) {
      if (!preserve(attr.name) && !next.hasAttribute(attr.name)) node.removeAttribute(attr.name);
    }
    for (const attr of next.attributes) {
      if (!preserve(attr.name) && node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
    }
    events(node, next);
    if (next._pendingChart) { updateChart(node, next._pendingChart); return; }
    if (oldChart) oldChart.dispose();
    const previous = [...node.childNodes], used = new Set();
    const keyed = new Map(previous.filter(key).map(child => [key(child), child]));
    let cursor = node.firstChild;
    for (const child of [...next.childNodes]) {
      let match = key(child) ? keyed.get(key(child)) : previous.find(old => !used.has(old) && !key(old) && compatible(old, child));
      if (match && !compatible(match, child)) match = null;
      if (match) {
        used.add(match);
        if (match !== cursor) node.insertBefore(match, cursor);
        patch(match, child);
      } else { match = child; node.insertBefore(match, cursor); }
      cursor = match.nextSibling;
    }
    for (const child of previous) if (!used.has(child)) { dispose(child); child.remove(); }
  }
  function commit(node, next) {
    const scroll = [node, ...node.querySelectorAll('*')].filter(n => n.scrollTop || n.scrollLeft)
      .map(n => [n, n.scrollTop, n.scrollLeft]);
    const y = window.scrollY, x = window.scrollX;
    patch(node, next);
    for (const dom of node.querySelectorAll('[data-refresh-chart]')) if (dom._pendingChart) updateChart(dom, dom._pendingChart);
    for (const [n, top, left] of scroll) if (n.isConnected) { n.scrollTop = top; n.scrollLeft = left; }
    window.scrollTo(x, y);
  }
  return { live, draft, chart, commit };
})();

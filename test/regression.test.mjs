import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));
function dom() {
  const nodes = new Map();
  const get = (selector) => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        value: "",
        style: {},
        dataset: {},
        handlers: {},
        textContent: "",
        getAttribute() {
          return "";
        },
        setAttribute() {},
        removeAttribute() {},
        addEventListener(type, fn) {
          this.handlers[type] = fn;
        },
        querySelector() {
          return get("span");
        },
        scrollTo() {},
        append() {},
        insertBefore() {},
      });
    return nodes.get(selector);
  };
  return { querySelector: get, createElement: get, nodes };
}
function page() {
  const registered = [];
  const document = dom();
  document.modelContext = { registerTool: async (tool) => registered.push(tool) };
  const context = vm.createContext({
    document,
    navigator: {},
    location: { origin: "http://localhost:8787" },
    window: { postMessage() {}, addEventListener() {} },
    console,
  });
  vm.runInContext(source("site/app.js"), context);
  return {
    registered,
    run: (code) => vm.runInContext(code, context),
    call: (name, args) =>
      vm.runInContext(
        `tools.find((tool) => tool.name === ${JSON.stringify(name)}).execute(${JSON.stringify(args)})`,
        context,
      ),
  };
}
test("invalid inputs do not alter page state", async () => {
  const p = page();
  const before = plain(p.run("snapshot()"));
  for (const room of ["toString", "constructor", "__proto__", null]) {
    await assert.rejects(
      p.call("gym_set_preferences", { room, strength: 45, variety: 35, convenience: 20 }),
    );
    assert.deepEqual(plain(p.run("snapshot()")), before);
  }
  await assert.rejects(p.call("gym_update_profile", { height: "178", weight: 78, age: 34 }));
  assert.deepEqual(plain(p.run("snapshot()")), before);
});
test("normalized mixes stay nonnegative integer totals of 100", () => {
  const p = page();
  for (const values of [
    [1, 7, 0],
    [0.2, 0.3, 0.1],
    [0, 0, 100],
    [1, 1, 1],
    [Number.MIN_VALUE, 0, 0],
  ]) {
    const mix = p.run(
      `normalizeMix(${JSON.stringify(Object.fromEntries(["strength", "variety", "convenience"].map((k, i) => [k, values[i]])))})`,
    );
    assert.equal(
      Object.values(mix).reduce((a, b) => a + b, 0),
      100,
    );
    assert.ok(Object.values(mix).every((v) => Number.isInteger(v) && v >= 0));
  }
});
test("recommendations never exceed selected room", async () => {
  const p = page();
  await p.call("gym_update_profile", { height: 178, weight: 160, age: 18 });
  for (const room of ["compact", "standard", "dedicated"]) {
    for (let strength = 0; strength <= 100; strength += 10) {
      await p.call("gym_set_preferences", {
        room,
        strength,
        variety: 100 - strength,
        convenience: 0,
      });
      assert.ok(p.run("roomRank[recommendation().room] <= roomRank[state.preferences.room]"));
    }
  }
});
function content(nativeAvailable = true, failure = false) {
  let handler;
  const events = {};
  const calls = [];
  const bridge = [];
  const window = {
    addEventListener: (type, fn) => (events[type] = fn),
    postMessage(message) {
      bridge.push(message);
      queueMicrotask(() =>
        events.message({
          source: window,
          origin: "http://localhost:8787",
          data: {
            channel: message.channel,
            direction: "page-response",
            id: message.id,
            ok: true,
            result: [],
          },
        }),
      );
    },
  };
  const tools = ["gym_open_fit_sidecar", "gym_update_profile"].map((name) => ({ name, window }));
  const native = {
    getTools: async () => tools,
    async executeTool(tool, args) {
      calls.push({ name: tool.name, args });
      if (typeof args !== "object" || args === null || Array.isArray(args))
        throw new TypeError("invalid input object: value is not an object");
      if (tool.name === "gym_update_profile" && failure)
        throw new Error("Mutation failed after dispatch");
      return JSON.stringify(
        tool.name === "gym_open_fit_sidecar"
          ? {
              content: [
                {
                  type: "resource",
                  resource: {
                    uri: "ui://form-factor/equipment-fit",
                    mimeType: "text/html;profile=mcp-app",
                    text: "<!doctype html>",
                  },
                },
              ],
            }
          : { revision: 2 },
      );
    },
  };
  const context = vm.createContext({
    document: nativeAvailable ? { modelContext: native } : {},
    navigator: {},
    window,
    location: { origin: "http://localhost:8787" },
    crypto: { randomUUID: () => "document-1" },
    console,
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: { onMessage: { addListener: (fn) => (handler = fn) }, sendMessage: async () => {} },
    },
  });
  vm.runInContext(source("extension/content-script.js"), context);
  return {
    calls,
    bridge,
    request: (message) => new Promise((resolve) => handler(message, {}, resolve)),
  };
}
test("native discovery does not execute tools; failed writes are not replayed", async () => {
  const c = content(true, true);
  const discovery = await c.request({ type: "LIST_TOOLS" });
  assert.equal(discovery.ok, true);
  assert.equal(discovery.result.transport, "WebMCP");
  assert.equal(c.calls.length, 0);
  const result = await c.request({
    type: "CALL_TOOL",
    name: "gym_update_profile",
    arguments: { height: 190 },
    documentToken: "document-1",
  });
  assert.equal(result.ok, false);
  assert.equal(c.calls.filter((c) => c.name === "gym_update_profile").length, 1);
  assert.equal(c.bridge.length, 0);
  const stale = await c.request({
    type: "CALL_TOOL",
    name: "gym_update_profile",
    documentToken: "old",
  });
  assert.equal(stale.ok, false);
  assert.equal(c.calls.filter((c) => c.name === "gym_update_profile").length, 1);
});
test("missing native API reports a setup error without a fallback", async () => {
  const c = content(null);
  const result = await c.request({ type: "LIST_TOOLS" });
  assert.equal(result.ok, false);
  assert.match(result.error, /WebMCP is unavailable/);
  assert.equal(c.bridge.length, 0);
  assert.equal(c.calls.length, 0);
});
function panel() {
  const document = dom();
  const messages = [];
  let listener;
  const events = {};
  document.querySelector("#app-frame").contentWindow = { postMessage: (m) => messages.push(m) };
  const context = vm.createContext({
    document,
    window: { addEventListener: (type, fn) => (events[type] = fn) },
    URL,
    setTimeout,
    clearTimeout,
    console,
    chrome: {
      tabs: {
        query: async () => [{ id: 1, url: "http://localhost:8787/" }],
        sendMessage: async () => ({
          ok: true,
          result: {
            tools: [{ name: "gym_open_fit_sidecar" }],
            documentToken: "doc1",
            transport: "WebMCP",
          },
        }),
        onActivated: { addListener() {} },
        onUpdated: { addListener() {} },
      },
      runtime: { onMessage: { addListener: (fn) => (listener = fn) } },
    },
  });
  vm.runInContext(source("extension/sidepanel.js"), context);
  return { context, messages, listener, events, run: (code) => vm.runInContext(code, context) };
}
test("panel rejects other tabs, frames and stale documents", async () => {
  const p = panel();
  await flush();
  p.run("appReady=true; appDescriptor={}");
  const message = { type: "PAGE_CONTEXT_CHANGED", state: { revision: 3 }, documentToken: "doc1" };
  p.listener(message, { tab: { id: 2 }, frameId: 0 });
  p.listener(message, { tab: { id: 1 }, frameId: 1 });
  p.listener({ ...message, documentToken: "old" }, { tab: { id: 1 }, frameId: 0 });
  assert.equal(p.messages.length, 0);
  p.listener(message, { tab: { id: 1 }, frameId: 0 });
  assert.equal(p.messages.length, 1);
});
test("App result rejects unknown, missing, oversized UI and unapproved tools", async () => {
  const p = panel();
  await flush();
  const resource = {
    uri: "ui://form-factor/equipment-fit",
    mimeType: "text/html;profile=mcp-app",
    text: "<!doctype html><title>View</title>",
  };
  const meta = { allowedPageTools: ["gym_update_profile"] };
  const result = (resourcePatch = {}, metaPatch = {}, ui = { resourceUri: resource.uri }) => ({
    content: [
      { type: "text", text: "ready" },
      { type: "resource", resource: { ...resource, ...resourcePatch } },
    ],
    _meta: { ui, "webmcp-apps": { ...meta, ...metaPatch } },
  });
  p.context.result = result();
  assert.equal(p.run("validateAppResult(result).html"), resource.text);
  for (const [resourcePatch, metaPatch] of [
    [{ uri: "ui://unknown" }, {}],
    [{ mimeType: "text/html" }, {}],
    [{ text: "" }, {}],
    [{ text: "x".repeat(512 * 1024 + 1) }, {}],
    [{}, { allowedPageTools: ["delete_everything"] }],
    [{}, { allowedPageTools: undefined }],
  ]) {
    p.context.result = result(resourcePatch, metaPatch);
    assert.throws(() => p.run("validateAppResult(result)"));
  }
  // The MCP Apps link is required, and must name the embedded resource.
  for (const ui of [null, {}, { resourceUri: "ui://unknown" }]) {
    p.context.result = result({}, {}, ui);
    assert.throws(() => p.run("validateAppResult(result)"), /not recognized/);
  }
  p.context.result = { content: [{ type: "text", text: "no UI" }] };
  assert.throws(() => p.run("validateAppResult(result)"));
  p.context.result = { _meta: { ui: { resourceUri: "ui://form-factor/equipment-fit" } } };
  assert.throws(() => p.run("validateAppResult(result)"), /no MCP Apps UI resource/);
});
test("sandbox proxy receives the View HTML once, and tool-result omits it", async () => {
  const p = panel();
  await flush();
  p.context.appResult = {
    content: [
      { type: "text", text: "ready" },
      { type: "resource", resource: { uri: "ui://form-factor/equipment-fit", text: "<html>" } },
    ],
    structuredContent: { revision: 1 },
  };
  p.run("appDescriptor = { html: '<html>', allowedPageTools: [] }; appResult = this.appResult");
  const frame = p.run("elements.frame.contentWindow");
  const ready = { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} };
  await p.events.message({ source: frame, data: ready });
  await p.events.message({ source: frame, data: ready });
  const delivered = p.messages.filter(
    (m) => m.method === "ui/notifications/sandbox-resource-ready",
  );
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].params.html, "<html>");
  p.run("sendToolData(appResult)");
  const toolResult = p.messages.find((m) => m.method === "ui/notifications/tool-result");
  assert.deepEqual(plain(toolResult.params.content), [{ type: "text", text: "ready" }]);
});
test("draft edits survive notifications, keyboard repeats accumulate, and writes serialize", async () => {
  const document = dom();
  const rooms = ["compact", "standard", "dedicated"].map((value) => ({
    value,
    checked: value === "standard",
    addEventListener() {},
  }));
  document.querySelectorAll = () => rooms;
  const sent = [];
  let receive;
  const timers = new Map();
  let id = 0;
  const parent = { postMessage: (m) => sent.push(m) };
  const context = vm.createContext({
    document,
    window: { parent, addEventListener: (_, fn) => (receive = fn) },
    console,
    setTimeout: (fn, ms) => {
      timers.set(++id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(source("site/fit-sidecar.js"), context);
  const initial = {
    profile: { height: 178, weight: 78, age: 34 },
    preferences: { room: "standard", mix: { strength: 45, variety: 35, convenience: 20 } },
    revision: 1,
  };
  context.initial = initial;
  vm.runInContext("render(initial)", context);
  document.querySelector("#height").value = "190";
  vm.runInContext("scheduleProfileUpdate(); render({...initial,revision:2})", context);
  assert.equal(document.querySelector("#height").value, "190");
  const key = document.querySelector("#mix-triangle").handlers.keydown;
  key({ key: "ArrowRight", preventDefault() {} });
  const first = vm.runInContext("draftMix.convenience", context);
  key({ key: "ArrowRight", preventDefault() {} });
  assert.ok(vm.runInContext("draftMix.convenience", context) > first);
  for (const timer of [...timers.values()].filter((t) => t.ms < 1000)) timer.fn();
  await flush();
  let calls = sent.filter((m) => m.method === "tools/call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.arguments.height, 190);
  receive({
    source: parent,
    data: {
      jsonrpc: "2.0",
      id: calls[0].id,
      result: { ...initial, profile: { ...initial.profile, height: 190 }, revision: 3 },
    },
  });
  await flush();
  calls = sent.filter((m) => m.method === "tools/call");
  assert.equal(calls.length, 2);
});

test("native calls pass object arguments and decode the result", async () => {
  const c = content();
  const args = { height: 190, weight: 90, age: 40 };
  const result = await c.request({
    type: "CALL_TOOL",
    name: "gym_update_profile",
    arguments: args,
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.revision, 2);
  const call = c.calls.find((call) => call.name === "gym_update_profile");
  assert.deepEqual(plain(call.args), args);
  assert.equal(c.bridge.length, 0);
});

test("opening errors are visible; closing discards a late opening result", async () => {
  const failed = panel();
  await flush();
  failed.run(
    'chrome.tabs.sendMessage = async () => ({ok: false, error: "Native execution failed"})',
  );
  await failed.run("openFitTool()");
  assert.equal(failed.run("pageReady"), false);
  assert.equal(failed.run("elements.origin.textContent"), "Native execution failed");
  const stale = panel();
  await flush();
  let reply;
  stale.context.chrome.tabs.sendMessage = () =>
    new Promise((resolve) => {
      reply = resolve;
    });
  const opening = stale.run("openFitTool()");
  stale.run("resetToolSurface()");
  reply({ ok: true, result: {} });
  await opening;
  assert.equal(stale.run("appDescriptor"), null);
  assert.equal(stale.run("elements.toolSurface.hidden"), true);
  assert.equal(stale.run("pageReady"), true);
});

test("page registers all three tools and returns the View as an embedded resource", async () => {
  const p = page();
  await flush();
  assert.deepEqual(
    p.registered.map((tool) => tool.name),
    ["gym_open_fit_sidecar", "gym_update_profile", "gym_set_preferences"],
  );
  p.run('globalThis.FIT_SIDECAR_HTML = "<!doctype html><title>View</title>"');
  const result = await p.registered[0].execute({});
  const resource = result.content.find((block) => block.type === "resource").resource;
  assert.equal(resource.uri, "ui://form-factor/equipment-fit");
  assert.equal(resource.mimeType, "text/html;profile=mcp-app");
  assert.equal(resource.text, "<!doctype html><title>View</title>");
  assert.deepEqual(plain(result._meta.ui), { resourceUri: "ui://form-factor/equipment-fit" });
  assert.deepEqual(plain(result._meta["webmcp-apps"].allowedPageTools), [
    "gym_update_profile",
    "gym_set_preferences",
  ]);
  assert.equal(result.structuredContent.revision, 1);
});
test("server inlines the sidecar into one self-contained HTML document", async () => {
  const server = source("server.mjs");
  const start = server.indexOf("function sidecarHtml()");
  const body = server.slice(start, server.indexOf("\napp.get(", start));
  const sidecarHtml = new Function(
    "readFileSync",
    "import_meta_url",
    `${body.replaceAll("import.meta.url", "import_meta_url")}; return sidecarHtml;`,
  )(readFileSync, new URL("../server.mjs", import.meta.url).href)();
  assert.doesNotMatch(sidecarHtml, /href="\/fit-sidecar\.css"|src="\/fit-sidecar\.js"/);
  assert.match(sidecarHtml, /<style>[\s\S]+<\/style>/);
  assert.match(sidecarHtml, /ui\/initialize/);
});
test("server inlining tolerates attribute formatting and escapes </script", () => {
  const server = source("server.mjs");
  const start = server.indexOf("function sidecarHtml()");
  const body = server.slice(start, server.indexOf("\napp.get(", start));
  const files = {
    "fit-sidecar.css": "body { color: red; }",
    "fit-sidecar.js": 'const tag = "</script>";',
    "fit-sidecar.html":
      "<head><link href='/fit-sidecar.css' rel='stylesheet'></head>" +
      "<body><script defer src='/fit-sidecar.js'></script></body>",
  };
  const readFileSync = (url) => files[url.pathname.split("/").pop()];
  const html = new Function(
    "readFileSync",
    "import_meta_url",
    `${body.replaceAll("import.meta.url", "import_meta_url")}; return sidecarHtml;`,
  )(readFileSync, "file:///repo/server.mjs")();
  assert.equal(html.match(/<\/script/g).length, 1);
  assert.match(html, /<style>\nbody \{ color: red; \}\n<\/style>/);
  assert.match(html, /const tag = "<\\\/script>";/);
});
function proxy() {
  const events = {};
  const toHost = [];
  const toView = [];
  const written = [];
  const parent = { postMessage: (message, origin) => toHost.push({ message, origin }) };
  const inner = {
    setAttribute(name, value) {
      this[name] = value;
    },
    contentWindow: { postMessage: (message) => toView.push(message) },
    set srcdoc(html) {
      written.push(html);
    },
  };
  const context = vm.createContext({
    window: { parent, addEventListener: (type, fn) => (events[type] = fn) },
    location: { origin: "chrome-extension://abc" },
    document: { title: "View", createElement: () => inner, body: { append() {} } },
  });
  vm.runInContext(source("extension/app-host.js"), context);
  const fromHost = (data, origin = "chrome-extension://abc") =>
    events.message({ source: parent, origin, data });
  const fromView = (data) => events.message({ source: inner.contentWindow, origin: "null", data });
  return { inner, toHost, toView, written, fromHost, fromView };
}
test("sandbox proxy loads the View in an inner iframe and relays non-sandbox messages", () => {
  const x = proxy();
  assert.equal(x.inner.sandbox, "allow-scripts");
  assert.deepEqual(plain(x.toHost), [
    {
      message: { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} },
      origin: "chrome-extension://abc",
    },
  ]);
  const ready = (html) => ({
    jsonrpc: "2.0",
    method: "ui/notifications/sandbox-resource-ready",
    params: { html },
  });
  x.fromHost(ready("<p>evil</p>"), "http://localhost:8787");
  x.fromHost(ready("<p>view</p>"));
  x.fromHost(ready("<p>again</p>"));
  assert.deepEqual(x.written, ["<p>view</p>"]);
  assert.equal(x.toView.length, 0);
  const result = { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {} };
  x.fromHost(result);
  assert.deepEqual(plain(x.toView), [result]);
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } };
  x.fromView(call);
  x.fromView({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} });
  assert.deepEqual(plain(x.toHost.slice(1)), [{ message: call, origin: "chrome-extension://abc" }]);
});

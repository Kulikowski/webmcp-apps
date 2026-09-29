const PAGE_ORIGIN = "http://localhost:8787";
const APP_RESOURCE_URI = "ui://form-factor/equipment-fit";
const PROTOCOL_VERSION = "2026-01-26";
const OPEN_TOOL = "gym_open_fit_sidecar";
const ALLOWED_APP_TOOLS = new Set(["gym_update_profile", "gym_set_preferences"]);
const APP_MIME_TYPE = "text/html;profile=mcp-app";
const EXTENSION_META_KEY = "webmcp-apps";
const MAX_APP_HTML_LENGTH = 512 * 1024;
// Manifest sandbox page that receives the View's HTML (see app-host.js).
const APP_HOST_PAGE = "app-host.html";
const TEARDOWN_TIMEOUT_MS = 1000;

const elements = {
  announcer: document.querySelector("#announcer"),
  composer: document.querySelector("#composer"),
  connection: document.querySelector("#connection-state"),
  conversation: document.querySelector("#conversation"),
  closeTool: document.querySelector("#close-tool"),
  frame: document.querySelector("#app-frame"),
  messages: document.querySelector("#messages"),
  origin: document.querySelector("#page-origin"),
  prompt: document.querySelector("#prompt"),
  suggestions: document.querySelector("#suggestions"),
  toolStatus: document.querySelector("#tool-status"),
  toolSurface: document.querySelector("#tool-surface"),
};

let activeTab = null;
let pageReady = false;
let appDescriptor = null;
let appResult = null;
let appReady = false;
let resourceDelivered = false;
let teardownCount = 0;
const teardowns = new Map();
let updateTimer = null;
let generation = 0;
let documentToken = null;

function setConnection(label, state) {
  elements.connection.querySelector("span").textContent = label;
  elements.connection.dataset.state = state;
}

function addMessage(role, text) {
  const item = document.createElement("li");
  item.className = `message message-${role}`;
  const speaker = document.createElement("span");
  speaker.className = "speaker";
  speaker.textContent = role === "user" ? "You" : "Agent";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const copy = document.createElement("p");
  copy.textContent = text;
  bubble.append(copy);
  item.append(speaker, bubble);
  elements.messages.insertBefore(item, elements.toolSurface);
  elements.conversation.scrollTo({ top: elements.conversation.scrollHeight, behavior: "smooth" });
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error("No active browser tab is available.");
  return tab;
}

function receiverMissing(error) {
  return /Receiving end does not exist|Could not establish connection/i.test(error?.message ?? "");
}

async function sendToPage(message, tab = activeTab, token = documentToken) {
  if (!tab?.id) throw new Error("No connected page.");
  const epoch = generation;
  message = { ...message, documentToken: token };
  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
  } catch (error) {
    if (!receiverMissing(error) || new URL(tab.url).origin !== PAGE_ORIGIN) throw error;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content-script.js"],
    });
    response = await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
  }
  if (epoch !== generation) throw new Error("The page connection changed.");
  if (!response?.ok) throw new Error(response?.error ?? "The page bridge did not respond.");
  return response.result;
}

// The MCP Apps host flow, with the two substitutions WebMCP forces: the
// `_meta.ui.resourceUri` link comes from the result (WebMCP tools have no
// `_meta`), and `resources/read` is answered by the matching embedded resource.
function validateAppResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("The WebMCP tool did not return an App result.");
  const uri = result._meta?.ui?.resourceUri;
  if (uri !== APP_RESOURCE_URI) throw new Error("The returned App resource was not recognized.");
  const resources = (Array.isArray(result.content) ? result.content : []).filter(
    (block) => block?.type === "resource" && block.resource?.uri === uri,
  );
  if (resources.length !== 1) throw new Error("The WebMCP result has no MCP Apps UI resource.");
  const { mimeType, text } = resources[0].resource;
  if (mimeType !== APP_MIME_TYPE) throw new Error("The returned App resource was not recognized.");
  if (typeof text !== "string" || !text || text.length > MAX_APP_HTML_LENGTH)
    throw new Error("The returned App resource is empty or too large.");
  // Not standard: stands in for MCP Apps' visibility: ["app"].
  const allowedPageTools = result._meta?.[EXTENSION_META_KEY]?.allowedPageTools;
  if (
    !Array.isArray(allowedPageTools) ||
    allowedPageTools.some((name) => !ALLOWED_APP_TOOLS.has(name))
  )
    throw new Error("The App requested a page tool outside the allowlist.");
  return { uri, html: text, allowedPageTools };
}

function toApp(message) {
  elements.frame.contentWindow?.postMessage(message, "*");
}

// The app opens the handshake and the host answers, which is the direction the
// MCP Apps lifecycle specifies.
function answerInitialize(id) {
  toApp({
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: PROTOCOL_VERSION,
      hostInfo: { name: "Form / Factor agent", version: "1.0.0" },
      hostCapabilities: { serverTools: {} },
      hostContext: { theme: "light", displayMode: "inline", platform: "web" },
    },
  });
}

// tool-input is sent once and carries the arguments the tool was called with.
// tool-result carries the CallToolResult itself.
function sendToolData(result) {
  if (!result) return;
  toApp({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {} } });
  // The View doesn't need its own HTML back, so drop that resource block.
  const content = (result.content ?? []).filter(
    (block) => block?.type !== "resource" || block.resource?.uri !== APP_RESOURCE_URI,
  );
  toApp({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { content, structuredContent: result.structuredContent },
  });
}

async function connect() {
  resetToolSurface("Reconnecting to the page");
  pageReady = false;
  documentToken = null;
  const epoch = generation;
  setConnection("Connecting", "pending");
  try {
    const tab = await currentTab();
    if (epoch !== generation) return;
    activeTab = tab;
    const origin = new URL(tab.url).origin;
    elements.origin.textContent = origin;
    if (origin !== PAGE_ORIGIN) throw new Error(`Open ${PAGE_ORIGIN} to use the training agent.`);
    const discovery = await sendToPage({ type: "LIST_TOOLS" }, tab, null);
    if (epoch !== generation) return;
    if (!discovery.tools?.some((tool) => tool.name === OPEN_TOOL))
      throw new Error("This page does not expose equipment-fit controls.");
    documentToken = discovery.documentToken;
    pageReady = true;
    setConnection(discovery.transport, "ready");
    elements.origin.textContent = `${origin} - ${discovery.transport}`;
  } catch (error) {
    if (epoch === generation) connectFailed(error);
  }
}

// MCP Apps: the host MUST send ui/resource-teardown before tearing a View down,
// and SHOULD wait for the answer. The old frame stays alive, hidden, until the
// View answers or the timeout passes; a fresh frame takes its place at once.
function tearDownView(reason) {
  const frame = elements.frame;
  if (!appReady) {
    frame.removeAttribute("src");
    return;
  }
  const fresh = frame.cloneNode(false);
  fresh.removeAttribute("src");
  frame.style.display = "none";
  frame.after(fresh);
  elements.frame = fresh;
  const id = `teardown-${++teardownCount}`;
  const done = () => {
    clearTimeout(timer);
    teardowns.delete(id);
    frame.remove();
  };
  const timer = setTimeout(done, TEARDOWN_TIMEOUT_MS);
  teardowns.set(id, { source: frame.contentWindow, done });
  frame.contentWindow?.postMessage(
    { jsonrpc: "2.0", id, method: "ui/resource-teardown", params: { reason } },
    "*",
  );
}

function resetToolSurface(reason = "Host reset") {
  tearDownView(reason);
  generation++;
  clearTimeout(updateTimer);
  appReady = false;
  resourceDelivered = false;
  appDescriptor = null;
  appResult = null;
  elements.toolSurface.hidden = true;
  elements.suggestions.hidden = false;
}

function connectFailed(error) {
  pageReady = false;
  resetToolSurface("Page connection failed");
  setConnection("No page", "error");
  elements.origin.textContent = error instanceof Error ? error.message : String(error);
}

async function openFitTool() {
  if (!pageReady) await connect();
  if (!pageReady) return;
  resetToolSurface("Replaced by new controls");
  const epoch = generation;
  elements.suggestions.hidden = true;
  elements.toolSurface.hidden = false;
  elements.toolStatus.textContent = "Opening controls...";
  elements.conversation.scrollTo({ top: elements.conversation.scrollHeight, behavior: "smooth" });
  try {
    const result = await sendToPage({ type: "CALL_TOOL", name: OPEN_TOOL, arguments: {} });
    if (epoch !== generation) return;
    appDescriptor = validateAppResult(result);
    appResult = result;
    appReady = false;
    elements.toolStatus.textContent = "Controls loading";
    elements.frame.src = APP_HOST_PAGE;
    elements.announcer.textContent =
      "Equipment fit controls opened. Results will appear on the website.";
  } catch (error) {
    if (epoch !== generation) return;
    addMessage("agent", error.message);
    connectFailed(error);
  }
}

async function handlePrompt(prompt) {
  const text = prompt.trim();
  if (!text) return;
  addMessage("user", text);
  elements.suggestions.hidden = true;
  elements.prompt.value = "";
  if (/equipment|fit|home gym|recommend|choose|controls/i.test(text)) {
    addMessage(
      "agent",
      "I’ll use this page’s equipment-fit tool. Adjust the controls below; I’ll place the recommendation on the website.",
    );
    await openFitTool();
  } else {
    addMessage(
      "agent",
      "I can help choose equipment from this page. Ask me to open the fit controls and I’ll use the page’s WebMCP tool.",
    );
  }
}

window.addEventListener("message", async (event) => {
  const data = event.data;
  const teardown = teardowns.get(data?.id);
  if (teardown && event.source === teardown.source && data.method === undefined)
    return teardown.done();
  if (event.source !== elements.frame.contentWindow || data?.jsonrpc !== "2.0") return;
  const epoch = generation;
  if (!appDescriptor) return;
  if (data.method === "ui/notifications/sandbox-proxy-ready") {
    // Deliver the embedded resource once; later requests are ignored.
    if (resourceDelivered) return;
    resourceDelivered = true;
    toApp({
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: { html: appDescriptor.html },
    });
  } else if (data.method === "ui/initialize") {
    if (data.params?.protocolVersion !== PROTOCOL_VERSION) {
      toApp({
        jsonrpc: "2.0",
        id: data.id,
        error: { code: -32602, message: "Unsupported protocol version" },
      });
      return;
    }
    answerInitialize(data.id);
  } else if (data.method === "ui/notifications/initialized") {
    appReady = true;
    elements.toolStatus.textContent = "Controls ready - changes appear on website";
    sendToolData(appResult);
  } else if (data.method === "tools/call") {
    try {
      if (
        !appReady ||
        !ALLOWED_APP_TOOLS.has(data.params?.name) ||
        !appDescriptor.allowedPageTools.includes(data.params.name)
      )
        throw new Error("That page tool is not available to this App.");
      const result = await sendToPage({
        type: "CALL_TOOL",
        name: data.params.name,
        arguments: data.params.arguments ?? {},
      });
      if (epoch !== generation) return;
      toApp({ jsonrpc: "2.0", id: data.id, result });
      elements.toolStatus.textContent = `Website updated - revision ${result.structuredContent?.revision}`;
      clearTimeout(updateTimer);
      updateTimer = setTimeout(() => {
        elements.toolStatus.textContent = "Controls ready - changes appear on website";
      }, 1800);
    } catch (error) {
      if (epoch !== generation) return;
      toApp({ jsonrpc: "2.0", id: data.id, error: { code: -32000, message: error.message } });
      elements.toolStatus.textContent = "Page update failed";
    }
  } else if (data.method === "ping" && data.id !== undefined) {
    toApp({ jsonrpc: "2.0", id: data.id, result: {} });
  } else if (typeof data.method === "string" && data.id !== undefined) {
    // JSON-RPC requires an answer to every request, including unsupported ones.
    toApp({
      jsonrpc: "2.0",
      id: data.id,
      error: { code: -32601, message: `Method not found: ${data.method}` },
    });
  }
});

// Not in MCP Apps: the spec sends one tool-result per tool call and has no push
// message. The page can change without one, so fresh page state reaches the
// View as another tool-result (see the README).
chrome.runtime.onMessage.addListener((message, sender) => {
  if (
    message.type !== "PAGE_CONTEXT_CHANGED" ||
    !appDescriptor ||
    sender.tab?.id !== activeTab?.id ||
    sender.frameId !== 0 ||
    message.documentToken !== documentToken
  )
    return;
  if (appResult?.structuredContent?.revision > message.state?.revision) return;
  if (appResult) appResult = { ...appResult, structuredContent: message.state };
  if (!appReady) return;
  toApp({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: {
      content: [{ type: "text", text: "Page state updated." }],
      structuredContent: message.state,
    },
  });
});

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  handlePrompt(elements.prompt.value);
});
elements.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
elements.suggestions.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-prompt]");
  if (button) handlePrompt(button.dataset.prompt);
});
elements.closeTool.addEventListener("click", () => {
  resetToolSurface("Closed by the user");
  addMessage("agent", "Fit controls closed. The last recommendation remains on the website.");
});
chrome.tabs.onActivated.addListener(() => {
  resetToolSurface("Tab changed");
  connect().catch(connectFailed);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTab?.id && changeInfo.status === "loading") {
    resetToolSurface("Page navigating");
    pageReady = false;
    documentToken = null;
    setConnection("Page navigating", "pending");
  } else if (tabId === activeTab?.id && changeInfo.status === "complete") {
    connect();
  }
});

connect().catch(connectFailed);

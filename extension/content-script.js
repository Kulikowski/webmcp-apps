(() => {
  if (globalThis.__formFactorContentScriptLoaded) return;
  globalThis.__formFactorContentScriptLoaded = true;

  const documentToken = crypto.randomUUID();

  // Page-state notifications only. Tool discovery and execution use WebMCP below.
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (
      data?.channel !== "form-factor-webmcp" ||
      data.direction !== "page-event" ||
      data.type !== "CONTEXT_CHANGED"
    )
      return;
    chrome.runtime
      .sendMessage({ type: "PAGE_CONTEXT_CHANGED", state: data.state, documentToken })
      .catch(() => {});
  });

  function requireWebMcp() {
    if (!document.modelContext?.getTools || !document.modelContext?.executeTool)
      throw new Error(
        "WebMCP is unavailable. Enable WebMCP in a supported Chrome build and reload the page.",
      );
  }

  async function discover() {
    requireWebMcp();
    const tools = await document.modelContext.getTools();
    return {
      transport: "WebMCP",
      documentToken,
      tools: tools
        .filter((tool) => tool.window === window)
        .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    };
  }

  async function callTool(name, args) {
    requireWebMcp();
    const tools = await document.modelContext.getTools();
    const tool = tools.find((tool) => tool.name === name && tool.window === window);
    if (!tool) throw new Error(`Page tool unavailable: ${name}`);
    // Chrome's documented executeTool signature takes a JSON string.
    // Execute once: errors propagate to the panel without retries.
    const result = await document.modelContext.executeTool(tool, JSON.stringify(args ?? {}));
    return typeof result === "string" ? JSON.parse(result) : result;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handle = async () => {
      if (message.documentToken && message.documentToken !== documentToken)
        throw new Error("The page document changed. Reconnect before updating it.");
      if (message.type === "PING") return { page: location.href };
      if (message.type === "LIST_TOOLS") return discover();
      if (message.type === "CALL_TOOL") return callTool(message.name, message.arguments);
      throw new Error(`Unknown extension message: ${message.type}`);
    };
    handle()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();

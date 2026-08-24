# MCP Apps-like UI over WebMCP

A localhost experiment: can a WebMCP tool return a UI that an agent host renders beside a website?
This demo uses a home-gym equipment page and a scripted Chrome side-panel agent (no LLM).

> [!WARNING]
>
> This repository is for demonstration and educational purposes only. It does not represent a real
> product or production-ready service. Security controls are deliberately simplified to keep the
> example easy to read.
>
> Use fictional profile values; do not enter personal information or other sensitive data. This demo
> requires no API keys or external AI service. Run it locally, and do not expose it directly to the
> public internet.

Available under the [MIT License](LICENSE).

## Where the experiment happens

1. [site/app.js](site/app.js) registers three tools with `document.modelContext.registerTool()`.
   `gym_open_fit_sidecar` returns the page state plus a private `_meta.ui` descriptor containing a
   UI URL and the page tools it may call.
2. [extension/content-script.js](extension/content-script.js) discovers and calls those tools
   through `document.modelContext.getTools()` and `document.modelContext.executeTool()`.
3. [extension/sidepanel.js](extension/sidepanel.js) interprets `_meta.ui`, checks the URL and tool
   allowlist, and loads [fit-sidecar.html](site/fit-sidecar.html) in a sandboxed iframe.
4. [site/fit-sidecar.js](site/fit-sidecar.js) uses MCP Apps-like `ui/initialize` and `tools/call`
   messages to send profile and preference changes through the extension. The recommendation updates
   on the original page.

The experiment is returning a UI descriptor from a WebMCP tool, rendering that UI in the extension,
and letting its controls call tools on the original page. This is a private convention between this
page and extension, not standard WebMCP UI support or MCP Apps interoperability. The equipment data
and recommendations are illustrative; page state resets on reload.

## The UI descriptor

`gym_open_fit_sidecar` returns this object in [site/app.js](site/app.js):

```js
return {
  content: [{ type: "text", text: "Interactive equipment fit sidecar ready." }],
  structuredContent: snapshot(),
  _meta: {
    ui: {
      resourceUri: "ui://form-factor/equipment-fit",
      resourceUrl: `${location.origin}/fit-sidecar.html`,
      mimeType: "text/html;profile=mcp-app",
      allowedPageTools: ["gym_update_profile", "gym_set_preferences"],
      title: "Equipment fit sidecar",
    },
  },
};
```

The extension interprets `_meta.ui` as instructions to open the controls; `structuredContent`
provides their initial state. This interpretation is the private convention being explored.

## Run locally

1. Install Node.js 22+ and a Chrome build with WebMCP support. Follow
   [Chrome's setup guide](https://developer.chrome.com/docs/ai/webmcp): enable
   `chrome://flags/#enable-webmcp-testing` where available, then relaunch Chrome.
2. Clone or download this repository. In a terminal at the repository root, run:

   ```sh
   npm install
   npm start
   ```

   Leave the terminal running. The server listens locally on port **8787**; keep this port because
   the extension is configured for it.

3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select this
   repository's `extension/` directory.
4. Open **http://localhost:8787/**. Click **Form / Factor Agent** in Chrome's extensions menu to
   open its side panel. If the page was already open when you loaded the extension, reload the page.
5. Ask **"Help me choose equipment for my home gym"**, or click the suggested prompt. Adjust the
   profile, room, and training mix in the side panel; the recommendation updates on the website.

If the panel reports that WebMCP is unavailable, check the browser build and flag, then reload the
page. Stop the local server with **Ctrl+C** in the terminal.

Checks: `npm test` and `npm run format:check`.

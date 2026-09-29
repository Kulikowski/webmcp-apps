# MCP Apps UI over WebMCP

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
   `gym_open_fit_sidecar` returns text, the page state, an MCP Apps `_meta.ui.resourceUri` link, and
   the View itself as an embedded resource (`ui://form-factor/equipment-fit`,
   `text/html;profile=mcp-app`).
2. [server.mjs](server.mjs) inlines [fit-sidecar.html](site/fit-sidecar.html) with its CSS and JS
   into one HTML document, the way an MCP server bundles a `ui://` resource.
3. [extension/content-script.js](extension/content-script.js) discovers and calls those tools
   through `document.modelContext.getTools()` and
   `document.modelContext.executeTool(tool, inputObject)`.
4. [extension/sidepanel.js](extension/sidepanel.js) resolves the link to the embedded resource and
   checks the tool allowlist. [app-host.html](extension/app-host.html) is the MCP Apps sandbox
   proxy: a manifest sandbox page on an opaque origin that loads the View in an inner iframe under
   the MCP Apps default CSP and relays messages between it and the side panel.
5. [site/fit-sidecar.js](site/fit-sidecar.js) uses MCP Apps `ui/initialize` and `tools/call`
   messages to send profile and preference changes through the extension. The recommendation updates
   on the original page.

## What differs from MCP Apps

The View, its `ui://` resource, the host-View messages and the sandbox proxy messages follow the
[MCP Apps spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).
WebMCP has tools only, so four things change:

| MCP Apps                                                     | Here                                                                           | Why                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `_meta.ui.resourceUri` on the tool definition                | The same field on the tool result                                              | WebMCP's `registerTool()` has no `_meta`, so the host can't know in advance     |
| Host fetches the View with `resources/read`                  | The same resource contents, embedded in the result's `content`                 | WebMCP has no resources. MCP Apps deferred embedded resources; MCP-UI uses them |
| `visibility: ["app"]` on app-only tools                      | `allowedPageTools` under a `webmcp-apps` `_meta` key, checked by the extension | WebMCP can't mark tools app-only, so other agents on the page still see them    |
| Sandbox proxy with `allow-same-origin`, View written into it | Opaque-origin proxy, View loaded as `srcdoc`                                   | An extension's only origin separate from the side panel is an opaque one        |

Rendering the View at all is a private convention between this page and this extension: WebMCP has
no rule that a host should render UI found in a tool result.

## The tool result

`gym_open_fit_sidecar` returns this object in [site/app.js](site/app.js):

```js
return {
  content: [
    { type: "text", text: "Interactive equipment fit controls opened for the user." },
    {
      type: "resource",
      resource: {
        uri: "ui://form-factor/equipment-fit",
        mimeType: "text/html;profile=mcp-app",
        text: html,
      },
    },
  ],
  structuredContent: snapshot(),
  _meta: {
    ui: { resourceUri: "ui://form-factor/equipment-fit" },
    "webmcp-apps": {
      allowedPageTools: ["gym_update_profile", "gym_set_preferences"],
    },
  },
};
```

An agent that can't render MCP Apps can ignore the resource block and use the text.
`structuredContent` gives the View its initial state.

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

// Sandbox proxy for the View, following the MCP Apps double-iframe pattern for
// web hosts (modelcontextprotocol/ext-apps examples/basic-host/src/sandbox.ts).
// This is a manifest sandbox page: it runs on an opaque origin, different from
// the side panel's, under the CSP in manifest.json. The View loads as the srcdoc
// of an inner iframe, which inherits that CSP. Sandbox flags also propagate, so
// the View gets its own opaque origin; the proxy can't document.write into it
// the way the reference does, and uses the reference's srcdoc fallback instead.
// The proxy relays every message except its own ui/notifications/sandbox-* ones.
(() => {
  const SANDBOX_PREFIX = "ui/notifications/sandbox-";
  // location.origin is the URL's origin (chrome-extension://<id>), which is the
  // side panel's origin, even though this document's own origin is opaque.
  const HOST_ORIGIN = location.origin;
  const inner = document.createElement("iframe");
  inner.setAttribute("sandbox", "allow-scripts");
  inner.title = document.title;
  document.body.append(inner);
  let loaded = false;

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data?.jsonrpc !== "2.0") return;
    if (event.source === window.parent) {
      if (event.origin !== HOST_ORIGIN) return;
      if (data.method === `${SANDBOX_PREFIX}resource-ready`) {
        const html = data.params?.html;
        if (loaded || typeof html !== "string" || !html) return;
        loaded = true;
        inner.srcdoc = html;
      } else if (!data.method?.startsWith(SANDBOX_PREFIX)) {
        inner.contentWindow?.postMessage(data, "*");
      }
    } else if (event.source === inner.contentWindow) {
      if (!data.method?.startsWith(SANDBOX_PREFIX)) window.parent.postMessage(data, HOST_ORIGIN);
    }
  });
  window.parent.postMessage(
    { jsonrpc: "2.0", method: `${SANDBOX_PREFIX}proxy-ready`, params: {} },
    HOST_ORIGIN,
  );
})();

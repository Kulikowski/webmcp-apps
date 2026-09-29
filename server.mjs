import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";

const root = fileURLToPath(new URL("./site", import.meta.url));
const port = Number(process.env.PORT ?? 8787);

const app = express();
app.use((_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  // Explicit localhost sources also work inside the sidecar's opaque sandbox origin.
  const origin = `http://localhost:${port}`;
  response.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      `script-src ${origin}`,
      `style-src ${origin} 'unsafe-inline'`,
      `img-src ${origin}`,
      "connect-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "),
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
// MCP Apps Views are single HTML documents, so inline the sidecar's CSS and JS
// the way an MCP server bundles its ui:// resource. The page loads the result
// and returns it as an embedded resource from gym_open_fit_sidecar.
function sidecarHtml() {
  const read = (file) => readFileSync(new URL(`./site/${file}`, import.meta.url), "utf8");
  const css = read("fit-sidecar.css");
  // Escape "</script" so the inlined JS can't close its own <script> element.
  const js = read("fit-sidecar.js").replaceAll("</script", "<\\/script");
  const stylesheet = /<link\b[^>]*\bhref=["']\/fit-sidecar\.css["'][^>]*>/;
  const script = /<script\b[^>]*\bsrc=["']\/fit-sidecar\.js["'][^>]*>\s*<\/script>/;
  const html = read("fit-sidecar.html")
    .replace(stylesheet, () => `<style>\n${css}\n</style>`)
    .replace(script, () => `<script>\n${js}\n</script>`);
  if (/fit-sidecar\.(css|js)/.test(html)) throw new Error("fit-sidecar.html could not be inlined.");
  return html;
}
app.get("/fit-sidecar.resource.js", (_request, response) => {
  response.type("text/javascript");
  response.send(`globalThis.FIT_SIDECAR_HTML = ${JSON.stringify(sidecarHtml())};\n`);
});
app.get("/favicon.ico", (_request, response) => response.status(204).end());
app.use(express.static(root, { index: "index.html", etag: false }));

app.listen(port, "127.0.0.1", () => {
  console.log(`WebMCP page: http://localhost:${port}/`);
});

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
app.get("/favicon.ico", (_request, response) => response.status(204).end());
app.use(express.static(root, { index: "index.html", etag: false }));

app.listen(port, "127.0.0.1", () => {
  console.log(`WebMCP page: http://localhost:${port}/`);
});

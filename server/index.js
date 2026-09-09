import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import locationsRouter from "./routes/locations.js";
import placesRouter from "./routes/places.js";
import { getStore } from "./lib/db.js";
import { googleMapsResolverEnabled } from "./lib/sources/googleMaps.js";
import { warmGoogleMapsCookies } from "./lib/sources/googleMapsPlace.js";

dotenv.config();

const app = express();
// API_PORT wins in development so the API stays on 3000 (where Vite proxies to)
// even when a tool exports PORT for the front-end dev server.
const PORT = process.env.API_PORT || process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, "../dist");

app.use(express.json({ limit: "128kb" }));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, store: getStore().kind });
});

app.use("/api", placesRouter);
app.use("/api", locationsRouter);

// Unknown API paths must 404 as JSON, not fall through to the SPA shell.
app.use("/api", (req, res) => {
  res.status(404).json({ error: `Unknown API endpoint: ${req.method} ${req.path}` });
});

app.use(express.static(distPath));

app.get("*", (req, res) => {
  res.sendFile(path.join(distPath, "index.html"), (error) => {
    if (error) {
      res.status(404).json({
        error: "Frontend build not found. Run `npm run build` first, or use `npm run dev`."
      });
    }
  });
});

app.use((error, req, res, next) => {
  console.error("[server] unhandled error:", error);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({ error: "Unexpected server error." });
});

// The Maps listing RPC only answers in full to a cookie a few seconds old;
// fetch it as soon as the module loads - on a serverless cold start as much
// as on a local server - so the first place a person opens does not pay
// that wait on top of its own requests.
if (googleMapsResolverEnabled()) {
  warmGoogleMapsCookies();
}

if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

export default app;

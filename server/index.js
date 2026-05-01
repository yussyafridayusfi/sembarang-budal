import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import locationsRouter from "./routes/locations.js";

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, "../dist");

app.use(express.json());
app.use("/api", locationsRouter);

app.use(express.static(distPath));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) {
    return next();
  }

  return res.sendFile(path.join(distPath, "index.html"), (error) => {
    if (error) {
      res.status(404).json({
        error: "Frontend build not found. Run npm run build first for production mode."
      });
    }
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

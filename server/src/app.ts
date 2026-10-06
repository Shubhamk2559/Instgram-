import path from "path";
import fs from "fs";
import express, { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { healthRouter } from "./routes/health";
import { authRouter, originGuard } from "./routes/auth";
import { instagramRouter } from "./routes/instagram";
import { reelsRouter } from "./routes/reels";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // behind Koyeb's proxy
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          "connect-src": ["'self'", "https://api.cloudinary.com"],
          "img-src": ["'self'", "data:", "https://res.cloudinary.com"],
          "media-src": ["'self'", "https://res.cloudinary.com"],
        },
      },
    })
  );
  app.use(express.json({ limit: "1mb" }));

  app.use("/api", originGuard);
  app.use("/api", healthRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/instagram", instagramRouter);
  app.use("/api/reels", reelsRouter);
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  // Serve the built frontend (same origin as the API).
  const webDist = path.resolve(__dirname, "../../web/dist");
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

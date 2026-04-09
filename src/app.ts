import express from "express";
import { env } from "./config/env";
import { createRouter } from "./routes";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    console.log(`[req] ${req.method} ${req.path}`);
    next();
  });
  app.use(createRouter());
  return app;
}

export function startServer() {
  const app = createApp();
  app.listen(env.PORT, "127.0.0.1", () => {
    console.log(`release-bot listening on http://127.0.0.1:${env.PORT}`);
  });
}

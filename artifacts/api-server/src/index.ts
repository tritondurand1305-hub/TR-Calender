import app from "./app";
import { logger } from "./lib/logger";
import { seedDemoEvents } from "./routes/events";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function start(): Promise<void> {
  if (process.env.NODE_ENV !== "production") {
    try {
      await seedDemoEvents();
    } catch (err) {
      logger.error({ err }, "Unable to initialize development demo events");
      process.exit(1);
    }
  }

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
  });
}

void start();

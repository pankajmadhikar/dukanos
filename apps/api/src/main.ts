import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { AppConfigService } from "./common/config/app-config.service";
import { AppLogger } from "./common/logging/app-logger.service";
import { redact } from "./common/logging/redact";
import { configureApp } from "./configure-app";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, bodyParser: false });
  const config = app.get(AppConfigService);
  const logger = app.get(AppLogger);
  configureApp(app);
  await app.listen(config.port);
  logger.write({
    level: "info",
    message: "api listening",
    module: "bootstrap",
    operation: "listen",
  });
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "startup failed";
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", message: redact(message) })}\n`,
  );
  process.exit(1);
});

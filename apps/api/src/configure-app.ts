import { INestApplication, VersioningType } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppConfigService } from "./common/config/app-config.service";
import { AppLogger } from "./common/logging/app-logger.service";

export function configureApp(app: INestApplication): void {
  const config = app.get(AppConfigService);
  app.useLogger(app.get(AppLogger));
  if (config.nodeEnv !== "test") {
    app.enableShutdownHooks();
  }
  const server = app.getHttpAdapter().getInstance() as {
    disable: (setting: string) => void;
  };
  server.disable("x-powered-by");
  app.setGlobalPrefix(config.apiPrefix);
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: "1",
  });

  if (config.swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle("DukaanOS API")
        .setDescription(
          "Shop API. Send Authorization: Bearer with the session token. Shop selection uses the dukaan_shop cookie or the x-dukaan-shop header issued by the server. x-tenant-id is ignored.",
        )
        .setVersion("1")
        .addBearerAuth(
          { type: "http", scheme: "bearer", bearerFormat: "session" },
          "session",
        )
        .build(),
    );
    SwaggerModule.setup(`${config.apiPrefix}/docs`, app, document);
  }
}

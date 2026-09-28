import { Injectable, NestMiddleware } from "@nestjs/common";
import { json, urlencoded } from "express";
import { AppConfigService } from "../config/app-config.service";

@Injectable()
export class JsonBodyMiddleware implements NestMiddleware {
  constructor(private readonly config: AppConfigService) {}

  use(req: unknown, res: unknown, next: (error?: unknown) => void): void {
    const limit = this.config.jsonBodyLimit;
    json({ limit })(req as never, res as never, (error?: unknown) => {
      if (error) {
        next(error);
        return;
      }
      urlencoded({ extended: false, limit })(req as never, res as never, next);
    });
  }
}

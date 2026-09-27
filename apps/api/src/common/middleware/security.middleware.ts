import { Injectable, NestMiddleware } from "@nestjs/common";
import cors, { CorsOptions } from "cors";
import { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { AppConfigService } from "../config/app-config.service";

@Injectable()
export class SecurityMiddleware implements NestMiddleware {
  private readonly helmetMiddleware: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void;
  private readonly corsMiddleware: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void;

  constructor(config: AppConfigService) {
    this.helmetMiddleware = helmet({
      contentSecurityPolicy: config.nodeEnv === "production",
    });
    const corsOptions: CorsOptions = {
      origin: [...config.corsOrigins],
      credentials: true,
    };
    this.corsMiddleware = cors(corsOptions);
  }

  use(req: Request, res: Response, next: NextFunction): void {
    this.helmetMiddleware(req, res, (error?: unknown) => {
      if (error) {
        next(error as Error);
        return;
      }
      this.corsMiddleware(req, res, next);
    });
  }
}

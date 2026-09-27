import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response } from "express";
import { resolveRequestId } from "../common/utils/request-id";
import { RequestContextService } from "./request-context.service";

export interface RequestWithId extends Request {
  requestId: string;
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly context: RequestContextService) {}

  use(req: Request, res: Response, next: () => void): void {
    const requestId = resolveRequestId(req.headers["x-request-id"]);
    res.setHeader("x-request-id", requestId);
    (req as RequestWithId).requestId = requestId;
    this.context.enter({
      requestId,
      userId: null,
      tenantId: null,
      sessionId: null,
      deviceId: null,
      role: null,
    });
    next();
  }
}

import { Module } from "@nestjs/common";
import { AuditRecorder } from "./audit-recorder";

@Module({
  providers: [AuditRecorder],
  exports: [AuditRecorder],
})
export class AuditModule {}

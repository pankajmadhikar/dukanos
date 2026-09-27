import { ApiProperty } from "@nestjs/swagger";

export class HealthLiveDto {
  @ApiProperty({ example: "ok" })
  status!: "ok";

  @ApiProperty({ example: "dukaanos-api" })
  service!: string;

  @ApiProperty({ nullable: true, example: "2f1c0c3e-7b1a-4e5d-9c2a-6b7d8e9f0a1b" })
  requestId!: string | null;
}

export class HealthReadyDto {
  @ApiProperty({ example: "ok" })
  status!: "ok";

  @ApiProperty({ example: "up" })
  database!: "up";

  @ApiProperty({ nullable: true })
  requestId!: string | null;
}

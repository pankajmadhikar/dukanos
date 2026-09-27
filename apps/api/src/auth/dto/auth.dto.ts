import { ApiProperty } from "@nestjs/swagger";
import { IsString, Matches, MaxLength, MinLength } from "class-validator";

export class RequestOtpDto {
  @ApiProperty({ example: "9876543210" })
  @IsString()
  @MinLength(10)
  @MaxLength(20)
  phone!: string;
}

export class VerifyOtpDto {
  @ApiProperty({ example: "+919876543210" })
  @IsString()
  @MinLength(10)
  @MaxLength(20)
  phone!: string;

  @ApiProperty({ example: "000000", description: "Six digit verification code." })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

import { HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";

const MONEY = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;
const STOCK = /^(?:0|[1-9]\d{0,14})(?:\.\d{1,3})?$/;

export function decimalText(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("not a decimal");
    }
    const text = Object.is(value, -0) ? "0" : String(value);
    if (text.includes("e") || text.includes("E")) {
      throw new Error("not a decimal");
    }
    return text;
  }
  if (typeof value === "string") {
    return value.trim();
  }
  throw new Error("not a decimal");
}

export function parseMoney(value: unknown): Prisma.Decimal {
  try {
    const text = decimalText(value);
    if (!MONEY.test(text)) {
      throw new Error("scale");
    }
    return new Prisma.Decimal(text);
  } catch (error) {
    if (error instanceof AppException) {
      throw error;
    }
    throw new AppException(
      ErrorCode.INVALID_PRODUCT_PRICE,
      "Enter a price with up to 2 decimal places.",
      HttpStatus.BAD_REQUEST,
    );
  }
}

export function parseStock(value: unknown): Prisma.Decimal {
  try {
    const text = decimalText(value);
    if (!STOCK.test(text)) {
      throw new Error("scale");
    }
    return new Prisma.Decimal(text);
  } catch (error) {
    if (error instanceof AppException) {
      throw error;
    }
    throw new AppException(
      ErrorCode.INVALID_MINIMUM_STOCK,
      "Enter a stock level with up to 3 decimal places.",
      HttpStatus.BAD_REQUEST,
    );
  }
}

export function formatMoney(value: Prisma.Decimal | string | number | null): string | null {
  if (value === null) {
    return null;
  }
  const decimal = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
  return decimal.toFixed(2);
}

export function formatStock(value: Prisma.Decimal | string | number | null): string | null {
  if (value === null) {
    return null;
  }
  const decimal = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
  return decimal.toFixed(3);
}

export function sameMoney(left: Prisma.Decimal | null, right: Prisma.Decimal): boolean {
  return left !== null && left.equals(right);
}

@ValidatorConstraint({ name: "shopMoney", async: false })
export class IsMoneyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === undefined) {
      return true;
    }
    try {
      return MONEY.test(decimalText(value));
    } catch {
      return false;
    }
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a non-negative amount with up to 2 decimal places.`;
  }
}

@ValidatorConstraint({ name: "shopStock", async: false })
export class IsStockConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === undefined) {
      return true;
    }
    try {
      return STOCK.test(decimalText(value));
    } catch {
      return false;
    }
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a non-negative quantity with up to 3 decimal places.`;
  }
}

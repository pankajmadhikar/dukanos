import { Injectable } from "@nestjs/common";
import {
  AI_CLIENT_FAILURE,
  AiAnalysisError,
  AiDetectedItem,
  AiProductAnalysis,
  AiProductIntakeInput,
  AiProductIntakeProvider,
} from "./ai-product-intake.provider";

const PARLE: AiDetectedItem = {
  name: "Parle-G Biscuits",
  brand: "Parle",
  category: "Biscuits",
  barcode: "8901234567890",
  quantity: "12",
  unit: "packet",
  purchasePrice: "10.00",
  sellingPrice: "12.00",
  confidence: 0.94,
};

/**
 * Deterministic stand-in for a vision model. The file name inside the object
 * key selects the fixture. This class does not touch the database.
 */
@Injectable()
export class MockAiProductIntakeProvider implements AiProductIntakeProvider {
  readonly name = "mock";
  readonly model = "mock";
  private readonly attempts = new Map<string, number>();
  private gate: Promise<void> = Promise.resolve();
  private openGate: () => void = () => undefined;
  private entered: Promise<void> = Promise.resolve();
  private markEntered: () => void = () => undefined;

  /** Test hook. The next `hold*.jpg` analysis waits until `release`. */
  armHold(): void {
    this.entered = new Promise((resolve) => {
      this.markEntered = resolve;
    });
    this.gate = new Promise((resolve) => {
      this.openGate = resolve;
    });
  }

  whenEntered(): Promise<void> {
    return this.entered;
  }

  release(): void {
    this.openGate();
  }

  async analyze(input: AiProductIntakeInput): Promise<AiProductAnalysis> {
    const file = (input.fileName ?? fileName(input.objectKey)).toLowerCase();
    if (file.startsWith("hold")) {
      this.markEntered();
      await this.gate;
    }
    if (file.startsWith("slow")) {
      await delay(300);
    }
    if (file.startsWith("fail-once")) {
      const attempt = (this.attempts.get(input.objectKey) ?? 0) + 1;
      this.attempts.set(input.objectKey, attempt);
      if (attempt === 1) {
        throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_UNAVAILABLE", retryable: true });
      }
    }
    if (file.startsWith("unreadable")) {
      throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_BAD_REQUEST", retryable: false });
    }
    return { items: itemsFor(file) };
  }
}

function itemsFor(file: string): AiDetectedItem[] {
  if (file.startsWith("unknown")) {
    return [{ name: "Unknown Product", quantity: "100", confidence: 0.42 }];
  }
  if (file.startsWith("low")) {
    return [{ name: "Loose Tea", quantity: "2", unit: "packet", confidence: 0.4 }];
  }
  if (file.startsWith("fuzzy")) {
    return [{ name: "Parle G 250g", unit: "packet", confidence: 0.91 }];
  }
  if (file.startsWith("sku-match")) {
    return [{ name: "Parle G Biscuits", sku: "parle-g", unit: "packet", confidence: 0.96 }];
  }
  if (file.startsWith("exact-name")) {
    return [{ name: "groundnut oil", unit: "packet", confidence: 0.93 }];
  }
  if (file.startsWith("multi")) {
    return [
      {
        name: "Sugar",
        barcode: "8901000000001",
        quantity: "4",
        unit: "packet",
        purchasePrice: "40.00",
        sellingPrice: "50.00",
        confidence: 0.92,
      },
      {
        name: "Maggi Noodles",
        barcode: "8901000000002",
        quantity: "6",
        unit: "packet",
        purchasePrice: "12.00",
        sellingPrice: "15.00",
        confidence: 0.9,
      },
    ];
  }
  if (file.startsWith("rollback")) {
    return [
      { name: "First Draft", sku: "SAME-SKU", unit: "packet", confidence: 0.95 },
      { name: "Second Draft", sku: "same-sku", unit: "packet", confidence: 0.95 },
    ];
  }
  if (file.startsWith("no-unit")) {
    return [{ name: "Loose Sugar", unit: "sack", confidence: 0.92 }];
  }
  if (file.startsWith("barcode-match")) {
    return [{ name: "Scanned Biscuits", barcode: "8901999888777", unit: "packet", confidence: 0.99 }];
  }
  if (file.startsWith("taken-barcode")) {
    return [{ name: "Taken Biscuits", barcode: "8901888777666", unit: "packet", confidence: 0.97 }];
  }
  return [PARLE];
}

function fileName(objectKey: string): string {
  return objectKey.slice(objectKey.lastIndexOf("/") + 1).toLowerCase();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

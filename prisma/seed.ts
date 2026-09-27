/**
 * Development seed only.
 * Every row is marked [DEV] or uses the dukaanos.local domain.
 * This does not create sales, stock, customers, or any shop activity.
 *
 * The seed connects as the migration role. That role bypasses row level
 * security. Shop requests must not use this role.
 */
import {
  BusinessType,
  DocumentType,
  MembershipRole,
  PrismaClient,
} from "@prisma/client";

const prisma = new PrismaClient();

const DEV_USER_ID = "00000000-0000-4000-8000-000000000001";
const DEV_TENANT_ID = "00000000-0000-4000-8000-000000000010";
const DEV_LOCATION_ID = "00000000-0000-4000-8000-000000000011";
const DEV_MEMBERSHIP_ID = "00000000-0000-4000-8000-000000000012";

const UNITS: Array<[string, string, string, number]> = [
  ["00000000-0000-4000-8000-000000000101", "Piece", "pc", 0],
  ["00000000-0000-4000-8000-000000000102", "Box", "box", 0],
  ["00000000-0000-4000-8000-000000000103", "Kg", "kg", 3],
  ["00000000-0000-4000-8000-000000000104", "Gram", "g", 3],
  ["00000000-0000-4000-8000-000000000105", "Liter", "L", 3],
  ["00000000-0000-4000-8000-000000000106", "Meter", "m", 3],
];

const EXPENSE_CATEGORIES: Array<[string, string]> = [
  ["00000000-0000-4000-8000-000000000201", "Rent"],
  ["00000000-0000-4000-8000-000000000202", "Electricity"],
  ["00000000-0000-4000-8000-000000000203", "Salary"],
  ["00000000-0000-4000-8000-000000000204", "Transport"],
  ["00000000-0000-4000-8000-000000000205", "Maintenance"],
  ["00000000-0000-4000-8000-000000000206", "Internet"],
  ["00000000-0000-4000-8000-000000000207", "Other"],
];

const COUNTERS: Array<[DocumentType, string]> = [
  [DocumentType.SALE, "S-"],
  [DocumentType.PURCHASE, "P-"],
  [DocumentType.SALE_RETURN, "SR-"],
  [DocumentType.PURCHASE_RETURN, "PR-"],
  [DocumentType.STOCK_ADJUSTMENT, "ADJ-"],
  [DocumentType.STOCK_TRANSFER, "TR-"],
];

async function main() {
  await prisma.user.upsert({
    where: { id: DEV_USER_ID },
    update: {
      name: "[DEV] Seed Owner",
      email: "dev-seed@dukaanos.local",
      isActive: true,
    },
    create: {
      id: DEV_USER_ID,
      phone: "+910000000001",
      email: "dev-seed@dukaanos.local",
      name: "[DEV] Seed Owner",
    },
  });

  await prisma.tenant.upsert({
    where: { id: DEV_TENANT_ID },
    update: {
      name: "[DEV] Pankaj Kirana",
      businessType: BusinessType.GROCERY,
      isActive: true,
    },
    create: {
      id: DEV_TENANT_ID,
      name: "[DEV] Pankaj Kirana",
      legalName: "[DEV] Pankaj Kirana",
      businessType: BusinessType.GROCERY,
      phone: "+910000000000",
      email: "shop-seed@dukaanos.local",
      city: "Development",
      state: "Test",
      timezone: "Asia/Kolkata",
      currency: "INR",
      country: "IN",
      negativeStockAllowed: false,
    },
  });

  await prisma.location.upsert({
    where: { id: DEV_LOCATION_ID },
    update: { name: "[DEV] Main Shop", isDefault: true, isActive: true },
    create: {
      id: DEV_LOCATION_ID,
      tenantId: DEV_TENANT_ID,
      name: "[DEV] Main Shop",
      code: "MAIN",
      isDefault: true,
    },
  });

  await prisma.tenant.update({
    where: { id: DEV_TENANT_ID },
    data: { defaultLocationId: DEV_LOCATION_ID },
  });

  await prisma.membership.upsert({
    where: { id: DEV_MEMBERSHIP_ID },
    update: { role: MembershipRole.OWNER, isActive: true },
    create: {
      id: DEV_MEMBERSHIP_ID,
      tenantId: DEV_TENANT_ID,
      userId: DEV_USER_ID,
      role: MembershipRole.OWNER,
    },
  });

  for (const [id, name, shortCode, decimalPlaces] of UNITS) {
    await prisma.unit.upsert({
      where: { id },
      update: { name, shortCode, decimalPlaces, isActive: true },
      create: {
        id,
        tenantId: DEV_TENANT_ID,
        name,
        shortCode,
        decimalPlaces,
      },
    });
  }

  for (const [id, name] of EXPENSE_CATEGORIES) {
    await prisma.expenseCategory.upsert({
      where: { id },
      update: { name, isSystem: true, isActive: true },
      create: {
        id,
        tenantId: DEV_TENANT_ID,
        name,
        isSystem: true,
      },
    });
  }

  for (const [documentType, prefix] of COUNTERS) {
    await prisma.documentCounter.upsert({
      where: {
        tenantId_documentType: {
          tenantId: DEV_TENANT_ID,
          documentType,
        },
      },
      update: { prefix },
      create: {
        tenantId: DEV_TENANT_ID,
        documentType,
        prefix,
        nextNumber: 1,
        padWidth: 5,
      },
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

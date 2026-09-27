-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "business_type" AS ENUM ('GROCERY', 'ELECTRICAL', 'HARDWARE', 'MACHINERY', 'WHOLESALE', 'GENERAL');

-- CreateEnum
CREATE TYPE "membership_role" AS ENUM ('OWNER', 'ADMIN', 'CASHIER', 'STOCK_KEEPER');

-- CreateEnum
CREATE TYPE "otp_purpose" AS ENUM ('LOGIN', 'INVITE', 'RECOVERY');

-- CreateEnum
CREATE TYPE "price_type" AS ENUM ('PURCHASE', 'SELLING');

-- CreateEnum
CREATE TYPE "price_change_source" AS ENUM ('MANUAL', 'PURCHASE', 'IMPORT');

-- CreateEnum
CREATE TYPE "price_source" AS ENUM ('LIST', 'CUSTOMER', 'MANUAL');

-- CreateEnum
CREATE TYPE "movement_type" AS ENUM ('OPENING_STOCK', 'PURCHASE', 'SALE', 'SALE_RETURN', 'SALE_VOID', 'PURCHASE_RETURN', 'DAMAGE', 'EXPIRY', 'ADJUSTMENT', 'TRANSFER_IN', 'TRANSFER_OUT');

-- CreateEnum
CREATE TYPE "sale_status" AS ENUM ('COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('UNPAID', 'PARTIAL', 'PAID');

-- CreateEnum
CREATE TYPE "document_status" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "adjustment_reason" AS ENUM ('OPENING', 'DAMAGE', 'EXPIRY', 'CORRECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER');

-- CreateEnum
CREATE TYPE "payment_direction" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "document_type" AS ENUM ('SALE', 'PURCHASE', 'SALE_RETURN', 'PURCHASE_RETURN', 'STOCK_ADJUSTMENT', 'STOCK_TRANSFER');

-- CreateEnum
CREATE TYPE "reference_type" AS ENUM ('SALE', 'SALE_VOID', 'SALE_RETURN', 'PURCHASE', 'PURCHASE_RETURN', 'STOCK_ADJUSTMENT', 'STOCK_TRANSFER', 'CUSTOMER_RECEIPT', 'SUPPLIER_PAYMENT', 'EXPENSE', 'OPENING_BALANCE', 'MANUAL_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "customer_ledger_entry_type" AS ENUM ('OPENING', 'CREDIT_SALE', 'PAYMENT', 'SALE_RETURN', 'SALE_VOID', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "supplier_ledger_entry_type" AS ENUM ('OPENING', 'PURCHASE', 'PAYMENT', 'PURCHASE_RETURN', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "ai_intake_status" AS ENUM ('UPLOADED', 'PROCESSING', 'DRAFT_READY', 'CONFIRMED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "ai_item_status" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ai_source_type" AS ENUM ('IMAGE', 'VIDEO');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "phone" VARCHAR(20) NOT NULL,
    "email" VARCHAR(320),
    "name" VARCHAR(200) NOT NULL,
    "password_hash" VARCHAR(255),
    "pin_hash" VARCHAR(255),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "device_id" UUID,
    "token_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "phone" VARCHAR(20) NOT NULL,
    "purpose" "otp_purpose" NOT NULL,
    "code_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "registered_by_id" UUID,
    "device_key" VARCHAR(128) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "platform" VARCHAR(32) NOT NULL,
    "app_version" VARCHAR(32),
    "last_seen_at" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" VARCHAR(200) NOT NULL,
    "legal_name" VARCHAR(200),
    "business_type" "business_type" NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "email" VARCHAR(320),
    "address" TEXT,
    "city" VARCHAR(120),
    "state" VARCHAR(120),
    "pincode" VARCHAR(12),
    "country" CHAR(2) NOT NULL DEFAULT 'IN',
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
    "negative_stock_allowed" BOOLEAN NOT NULL DEFAULT false,
    "default_location_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "membership_role" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "short_code" VARCHAR(8) NOT NULL,
    "decimal_places" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "parent_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "name_en" VARCHAR(200),
    "name_hi" VARCHAR(200),
    "name_mr" VARCHAR(200),
    "sku" VARCHAR(64),
    "category_id" UUID,
    "brand_id" UUID,
    "unit_id" UUID NOT NULL,
    "default_purchase_price" DECIMAL(18,2),
    "default_selling_price" DECIMAL(18,2),
    "average_cost" DECIMAL(18,2),
    "minimum_stock_level" DECIMAL(18,3),
    "maximum_stock_level" DECIMAL(18,3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_barcodes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "barcode" VARCHAR(64) NOT NULL,
    "barcode_type" VARCHAR(32),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_barcodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_price_history" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "price_type" "price_type" NOT NULL,
    "old_price" DECIMAL(18,2),
    "new_price" DECIMAL(18,2) NOT NULL,
    "source" "price_change_source" NOT NULL,
    "changed_by" UUID,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_product_prices" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "selling_price" DECIMAL(18,2) NOT NULL,
    "valid_from" TIMESTAMPTZ(6),
    "valid_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_product_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "phone" VARCHAR(20),
    "email" VARCHAR(320),
    "address" TEXT,
    "opening_balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "receivable_balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit_limit" DECIMAL(18,2),
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "phone" VARCHAR(20),
    "email" VARCHAR(320),
    "address" TEXT,
    "opening_balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "payable_balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "code" VARCHAR(32),
    "address" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_balances" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "average_cost" DECIMAL(18,2),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "movement_type" "movement_type" NOT NULL,
    "quantity_delta" DECIMAL(18,3) NOT NULL,
    "unit_cost" DECIMAL(18,2),
    "reference_type" "reference_type" NOT NULL,
    "reference_id" UUID NOT NULL,
    "source_line_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "business_date" DATE NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "supplier_id" UUID,
    "location_id" UUID NOT NULL,
    "bill_number" VARCHAR(32) NOT NULL,
    "supplier_invoice_number" VARCHAR(64),
    "purchase_date" TIMESTAMPTZ(6) NOT NULL,
    "business_date" DATE NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL,
    "discount_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "grand_total" DECIMAL(18,2) NOT NULL,
    "notes" TEXT,
    "status" "document_status" NOT NULL DEFAULT 'DRAFT',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unit_cost" DECIMAL(18,2) NOT NULL,
    "discount_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(18,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_returns" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "original_purchase_id" UUID NOT NULL,
    "supplier_id" UUID,
    "location_id" UUID NOT NULL,
    "return_number" VARCHAR(32) NOT NULL,
    "return_date" TIMESTAMPTZ(6) NOT NULL,
    "business_date" DATE NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL,
    "tax_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "grand_total" DECIMAL(18,2) NOT NULL,
    "refund_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "status" "document_status" NOT NULL DEFAULT 'CONFIRMED',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "purchase_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_return_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "purchase_return_id" UUID NOT NULL,
    "original_purchase_item_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unit_cost" DECIMAL(18,2) NOT NULL,
    "line_total" DECIMAL(18,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID,
    "location_id" UUID NOT NULL,
    "bill_number" VARCHAR(32) NOT NULL,
    "sale_date" TIMESTAMPTZ(6) NOT NULL,
    "business_date" DATE NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL,
    "discount_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "round_off" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "grand_total" DECIMAL(18,2) NOT NULL,
    "payment_status" "payment_status" NOT NULL,
    "status" "sale_status" NOT NULL DEFAULT 'COMPLETED',
    "notes" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unit_selling_price" DECIMAL(18,2) NOT NULL,
    "unit_cost" DECIMAL(18,2),
    "discount_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(18,2) NOT NULL,
    "price_source" "price_source" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_returns" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "original_sale_id" UUID NOT NULL,
    "customer_id" UUID,
    "location_id" UUID NOT NULL,
    "return_number" VARCHAR(32) NOT NULL,
    "return_date" TIMESTAMPTZ(6) NOT NULL,
    "business_date" DATE NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL,
    "refund_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "status" "document_status" NOT NULL DEFAULT 'CONFIRMED',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sale_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_return_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "sale_return_id" UUID NOT NULL,
    "original_sale_item_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unit_price" DECIMAL(18,2) NOT NULL,
    "unit_cost" DECIMAL(18,2),
    "line_total" DECIMAL(18,2) NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_adjustments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "adjustment_number" VARCHAR(32) NOT NULL,
    "adjustment_date" TIMESTAMPTZ(6) NOT NULL,
    "business_date" DATE NOT NULL,
    "reason" "adjustment_reason" NOT NULL,
    "status" "document_status" NOT NULL DEFAULT 'DRAFT',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_adjustment_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "stock_adjustment_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity_delta" DECIMAL(18,3) NOT NULL,
    "unit_cost" DECIMAL(18,2),
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_adjustment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "from_location_id" UUID NOT NULL,
    "to_location_id" UUID NOT NULL,
    "transfer_number" VARCHAR(32) NOT NULL,
    "transfer_date" TIMESTAMPTZ(6) NOT NULL,
    "business_date" DATE NOT NULL,
    "status" "document_status" NOT NULL DEFAULT 'DRAFT',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "stock_transfer_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transfer_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "payment_method" "payment_method" NOT NULL,
    "direction" "payment_direction" NOT NULL,
    "reference_type" "reference_type" NOT NULL,
    "reference_id" UUID,
    "customer_id" UUID,
    "supplier_id" UUID,
    "payment_date" TIMESTAMPTZ(6) NOT NULL,
    "business_date" DATE NOT NULL,
    "external_reference" VARCHAR(128),
    "notes" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_ledger" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "entry_type" "customer_ledger_entry_type" NOT NULL,
    "debit_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "running_balance" DECIMAL(18,2),
    "reference_type" "reference_type" NOT NULL,
    "reference_id" UUID,
    "business_date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_ledger" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "entry_type" "supplier_ledger_entry_type" NOT NULL,
    "debit_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "running_balance" DECIMAL(18,2),
    "reference_type" "reference_type" NOT NULL,
    "reference_id" UUID,
    "business_date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_categories" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "expense_date" TIMESTAMPTZ(6) NOT NULL,
    "business_date" DATE NOT NULL,
    "payment_id" UUID,
    "description" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_summaries" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "total_sales" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total_sales_returns" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "net_sales" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total_purchase" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "gross_profit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total_expenses" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "net_profit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cash_received" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit_sales" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "customer_collections" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "supplier_payments" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "closing_receivables" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "closing_payables" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "products_sold" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "transaction_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "daily_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_counters" (
    "tenant_id" UUID NOT NULL,
    "document_type" "document_type" NOT NULL,
    "prefix" VARCHAR(8) NOT NULL,
    "next_number" INTEGER NOT NULL DEFAULT 1,
    "pad_width" INTEGER NOT NULL DEFAULT 5,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "document_counters_pkey" PRIMARY KEY ("tenant_id","document_type")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID,
    "actor_user_id" UUID,
    "action" VARCHAR(64) NOT NULL,
    "entity_type" VARCHAR(64) NOT NULL,
    "entity_id" UUID NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_id" VARCHAR(64),

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "request_hash" VARCHAR(128),
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "aggregate_type" VARCHAR(64) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "outbox_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_intake_sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "source_type" "ai_source_type" NOT NULL,
    "media_reference" VARCHAR(500) NOT NULL,
    "status" "ai_intake_status" NOT NULL DEFAULT 'UPLOADED',
    "raw_output" JSONB,
    "failure_reason" TEXT,
    "confirmed_purchase_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_intake_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_intake_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "detected_name" VARCHAR(200),
    "detected_name_en" VARCHAR(200),
    "detected_name_hi" VARCHAR(200),
    "detected_name_mr" VARCHAR(200),
    "suggested_category_name" VARCHAR(120),
    "suggested_brand_name" VARCHAR(120),
    "suggested_barcode" VARCHAR(64),
    "suggested_quantity" DECIMAL(18,3),
    "suggested_purchase_price" DECIMAL(18,2),
    "suggested_selling_price" DECIMAL(18,2),
    "confidence" DECIMAL(5,4),
    "edited_name" VARCHAR(200),
    "edited_quantity" DECIMAL(18,3),
    "edited_purchase_price" DECIMAL(18,2),
    "edited_selling_price" DECIMAL(18,2),
    "status" "ai_item_status" NOT NULL DEFAULT 'PENDING',
    "matched_product_id" UUID,
    "raw_suggestion" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_intake_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_created_at_idx" ON "sessions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "otp_challenges_phone_purpose_created_at_idx" ON "otp_challenges"("phone", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "devices_tenant_id_is_active_idx" ON "devices"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "devices_tenant_id_id_key" ON "devices"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_tenant_id_device_key_key" ON "devices"("tenant_id", "device_key");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_tenant_id_id_key" ON "memberships"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_tenant_id_user_id_key" ON "memberships"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "units_tenant_id_id_key" ON "units"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "units_tenant_id_short_code_key" ON "units"("tenant_id", "short_code");

-- CreateIndex
CREATE UNIQUE INDEX "units_tenant_id_name_key" ON "units"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "categories_tenant_id_parent_id_idx" ON "categories"("tenant_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_tenant_id_id_key" ON "categories"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "brands_tenant_id_id_key" ON "brands"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "brands_tenant_id_name_key" ON "brands"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "products_tenant_id_is_active_idx" ON "products"("tenant_id", "is_active");

-- CreateIndex
CREATE INDEX "products_tenant_id_name_idx" ON "products"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "products_tenant_id_category_id_idx" ON "products"("tenant_id", "category_id");

-- CreateIndex
CREATE INDEX "products_tenant_id_brand_id_idx" ON "products"("tenant_id", "brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_id_key" ON "products"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_sku_key" ON "products"("tenant_id", "sku");

-- CreateIndex
CREATE INDEX "product_barcodes_tenant_id_product_id_idx" ON "product_barcodes"("tenant_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_barcodes_tenant_id_id_key" ON "product_barcodes"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_barcodes_tenant_id_barcode_key" ON "product_barcodes"("tenant_id", "barcode");

-- CreateIndex
CREATE INDEX "product_price_history_tenant_id_product_id_changed_at_idx" ON "product_price_history"("tenant_id", "product_id", "changed_at");

-- CreateIndex
CREATE UNIQUE INDEX "product_price_history_tenant_id_id_key" ON "product_price_history"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_product_prices_tenant_id_id_key" ON "customer_product_prices"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_product_prices_tenant_id_customer_id_product_id_key" ON "customer_product_prices"("tenant_id", "customer_id", "product_id");

-- CreateIndex
CREATE INDEX "customers_tenant_id_name_idx" ON "customers"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenant_id_id_key" ON "customers"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "suppliers_tenant_id_name_idx" ON "suppliers"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_tenant_id_id_key" ON "suppliers"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "locations_tenant_id_is_active_idx" ON "locations"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "locations_tenant_id_id_key" ON "locations"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "inventory_balances_tenant_id_location_id_idx" ON "inventory_balances"("tenant_id", "location_id");

-- CreateIndex
CREATE INDEX "inventory_balances_tenant_id_product_id_idx" ON "inventory_balances"("tenant_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_balances_tenant_id_id_key" ON "inventory_balances"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_balances_tenant_id_product_id_location_id_key" ON "inventory_balances"("tenant_id", "product_id", "location_id");

-- CreateIndex
CREATE INDEX "inventory_movements_tenant_id_product_id_occurred_at_idx" ON "inventory_movements"("tenant_id", "product_id", "occurred_at");

-- CreateIndex
CREATE INDEX "inventory_movements_tenant_id_product_id_business_date_idx" ON "inventory_movements"("tenant_id", "product_id", "business_date");

-- CreateIndex
CREATE INDEX "inventory_movements_tenant_id_location_id_idx" ON "inventory_movements"("tenant_id", "location_id");

-- CreateIndex
CREATE INDEX "inventory_movements_tenant_id_reference_type_reference_id_idx" ON "inventory_movements"("tenant_id", "reference_type", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_tenant_id_id_key" ON "inventory_movements"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_tenant_id_movement_type_source_line_id_key" ON "inventory_movements"("tenant_id", "movement_type", "source_line_id");

-- CreateIndex
CREATE INDEX "purchases_tenant_id_business_date_idx" ON "purchases"("tenant_id", "business_date");

-- CreateIndex
CREATE INDEX "purchases_tenant_id_supplier_id_idx" ON "purchases"("tenant_id", "supplier_id");

-- CreateIndex
CREATE INDEX "purchases_tenant_id_created_at_idx" ON "purchases"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_tenant_id_id_key" ON "purchases"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_tenant_id_bill_number_key" ON "purchases"("tenant_id", "bill_number");

-- CreateIndex
CREATE INDEX "purchase_items_tenant_id_purchase_id_idx" ON "purchase_items"("tenant_id", "purchase_id");

-- CreateIndex
CREATE INDEX "purchase_items_tenant_id_product_id_idx" ON "purchase_items"("tenant_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_items_tenant_id_id_key" ON "purchase_items"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "purchase_returns_tenant_id_business_date_idx" ON "purchase_returns"("tenant_id", "business_date");

-- CreateIndex
CREATE INDEX "purchase_returns_tenant_id_original_purchase_id_idx" ON "purchase_returns"("tenant_id", "original_purchase_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_returns_tenant_id_id_key" ON "purchase_returns"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_returns_tenant_id_return_number_key" ON "purchase_returns"("tenant_id", "return_number");

-- CreateIndex
CREATE INDEX "purchase_return_items_tenant_id_purchase_return_id_idx" ON "purchase_return_items"("tenant_id", "purchase_return_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_return_items_tenant_id_id_key" ON "purchase_return_items"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "sales_tenant_id_business_date_idx" ON "sales"("tenant_id", "business_date");

-- CreateIndex
CREATE INDEX "sales_tenant_id_customer_id_idx" ON "sales"("tenant_id", "customer_id");

-- CreateIndex
CREATE INDEX "sales_tenant_id_created_at_idx" ON "sales"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sales_tenant_id_id_key" ON "sales"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_tenant_id_bill_number_key" ON "sales"("tenant_id", "bill_number");

-- CreateIndex
CREATE INDEX "sale_items_tenant_id_sale_id_idx" ON "sale_items"("tenant_id", "sale_id");

-- CreateIndex
CREATE INDEX "sale_items_tenant_id_product_id_idx" ON "sale_items"("tenant_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_items_tenant_id_id_key" ON "sale_items"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "sale_returns_tenant_id_business_date_idx" ON "sale_returns"("tenant_id", "business_date");

-- CreateIndex
CREATE INDEX "sale_returns_tenant_id_original_sale_id_idx" ON "sale_returns"("tenant_id", "original_sale_id");

-- CreateIndex
CREATE INDEX "sale_returns_tenant_id_customer_id_idx" ON "sale_returns"("tenant_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_returns_tenant_id_id_key" ON "sale_returns"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_returns_tenant_id_return_number_key" ON "sale_returns"("tenant_id", "return_number");

-- CreateIndex
CREATE INDEX "sale_return_items_tenant_id_sale_return_id_idx" ON "sale_return_items"("tenant_id", "sale_return_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_return_items_tenant_id_id_key" ON "sale_return_items"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "stock_adjustments_tenant_id_business_date_idx" ON "stock_adjustments"("tenant_id", "business_date");

-- CreateIndex
CREATE UNIQUE INDEX "stock_adjustments_tenant_id_id_key" ON "stock_adjustments"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_adjustments_tenant_id_adjustment_number_key" ON "stock_adjustments"("tenant_id", "adjustment_number");

-- CreateIndex
CREATE INDEX "stock_adjustment_items_tenant_id_stock_adjustment_id_idx" ON "stock_adjustment_items"("tenant_id", "stock_adjustment_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_adjustment_items_tenant_id_id_key" ON "stock_adjustment_items"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "stock_transfers_tenant_id_business_date_idx" ON "stock_transfers"("tenant_id", "business_date");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_tenant_id_id_key" ON "stock_transfers"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_tenant_id_transfer_number_key" ON "stock_transfers"("tenant_id", "transfer_number");

-- CreateIndex
CREATE INDEX "stock_transfer_items_tenant_id_stock_transfer_id_idx" ON "stock_transfer_items"("tenant_id", "stock_transfer_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_items_tenant_id_id_key" ON "stock_transfer_items"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "payments_tenant_id_business_date_idx" ON "payments"("tenant_id", "business_date");

-- CreateIndex
CREATE INDEX "payments_tenant_id_customer_id_idx" ON "payments"("tenant_id", "customer_id");

-- CreateIndex
CREATE INDEX "payments_tenant_id_supplier_id_idx" ON "payments"("tenant_id", "supplier_id");

-- CreateIndex
CREATE INDEX "payments_tenant_id_reference_type_reference_id_idx" ON "payments"("tenant_id", "reference_type", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenant_id_id_key" ON "payments"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "customer_ledger_tenant_id_customer_id_business_date_idx" ON "customer_ledger"("tenant_id", "customer_id", "business_date");

-- CreateIndex
CREATE INDEX "customer_ledger_tenant_id_reference_type_reference_id_idx" ON "customer_ledger"("tenant_id", "reference_type", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_ledger_tenant_id_id_key" ON "customer_ledger"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "supplier_ledger_tenant_id_supplier_id_business_date_idx" ON "supplier_ledger"("tenant_id", "supplier_id", "business_date");

-- CreateIndex
CREATE INDEX "supplier_ledger_tenant_id_reference_type_reference_id_idx" ON "supplier_ledger"("tenant_id", "reference_type", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_ledger_tenant_id_id_key" ON "supplier_ledger"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_tenant_id_id_key" ON "expense_categories"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_tenant_id_name_key" ON "expense_categories"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "expenses_tenant_id_business_date_idx" ON "expenses"("tenant_id", "business_date");

-- CreateIndex
CREATE INDEX "expenses_tenant_id_category_id_idx" ON "expenses"("tenant_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_tenant_id_id_key" ON "expenses"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "daily_summaries_tenant_id_id_key" ON "daily_summaries"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "daily_summaries_tenant_id_business_date_key" ON "daily_summaries"("tenant_id", "business_date");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_entity_type_entity_id_idx" ON "audit_logs"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_occurred_at_idx" ON "audit_logs"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_tenant_id_id_key" ON "idempotency_keys"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_tenant_id_key_key" ON "idempotency_keys"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events"("status", "available_at");

-- CreateIndex
CREATE INDEX "outbox_events_tenant_id_created_at_idx" ON "outbox_events"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_tenant_id_id_key" ON "outbox_events"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "ai_intake_sessions_tenant_id_status_created_at_idx" ON "ai_intake_sessions"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_intake_sessions_tenant_id_id_key" ON "ai_intake_sessions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "ai_intake_items_tenant_id_session_id_idx" ON "ai_intake_items"("tenant_id", "session_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_intake_items_tenant_id_id_key" ON "ai_intake_items"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_intake_items_tenant_id_session_id_position_key" ON "ai_intake_items"("tenant_id", "session_id", "position");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_fk" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_fk" FOREIGN KEY ("registered_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_default_location_fk" FOREIGN KEY ("id", "default_location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_fk" FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_fk" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_brand_fk" FOREIGN KEY ("tenant_id", "brand_id") REFERENCES "brands"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_unit_fk" FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_product_fk" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_price_history" ADD CONSTRAINT "product_price_history_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_price_history" ADD CONSTRAINT "product_price_history_product_fk" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_price_history" ADD CONSTRAINT "product_price_history_actor_fk" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "customer_product_prices" ADD CONSTRAINT "customer_product_prices_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "customer_product_prices" ADD CONSTRAINT "customer_product_prices_customer_fk" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "customer_product_prices" ADD CONSTRAINT "customer_product_prices_product_fk" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_product_fk" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_location_fk" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_product_fk" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_location_fk" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_actor_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplier_fk" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_location_fk" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_creator_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchase_fk" FOREIGN KEY ("tenant_id", "purchase_id") REFERENCES "purchases"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_product_fk" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_purchase_fk" FOREIGN KEY ("tenant_id", "original_purchase_id") REFERENCES "purchases"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_supplier_fk" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_location_fk" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_creator_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_return_fk" FOREIGN KEY ("tenant_id", "purchase_return_id") REFERENCES "purchase_returns"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_item_fk" FOREIGN KEY ("tenant_id", "original_purchase_item_id") REFERENCES "purchase_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_product_fk" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_fk" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_location_fk" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_creator_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_fk" FOREIGN KEY ("tenant_id", "sale_id") REFERENCES "sales"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_product_fk" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_sale_fk" FOREIGN KEY ("tenant_id", "original_sale_id") REFERENCES "sales"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_customer_fk" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_location_fk" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_creator_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_return_fk" FOREIGN KEY ("tenant_id", "sale_return_id") REFERENCES "sale_returns"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_item_fk" FOREIGN KEY ("tenant_id", "original_sale_item_id") REFERENCES "sale_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_product_fk" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_location_fk" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_creator_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_adjustment_items" ADD CONSTRAINT "stock_adjustment_items_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_adjustment_items" ADD CONSTRAINT "stock_adjustment_items_adjustment_fk" FOREIGN KEY ("tenant_id", "stock_adjustment_id") REFERENCES "stock_adjustments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_adjustment_items" ADD CONSTRAINT "stock_adjustment_items_product_fk" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_fk" FOREIGN KEY ("tenant_id", "from_location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_fk" FOREIGN KEY ("tenant_id", "to_location_id") REFERENCES "locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_creator_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_transfer_fk" FOREIGN KEY ("tenant_id", "stock_transfer_id") REFERENCES "stock_transfers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_product_fk" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_fk" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_supplier_fk" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_creator_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "customer_ledger" ADD CONSTRAINT "customer_ledger_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "customer_ledger" ADD CONSTRAINT "customer_ledger_customer_fk" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "supplier_ledger" ADD CONSTRAINT "supplier_ledger_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "supplier_ledger" ADD CONSTRAINT "supplier_ledger_supplier_fk" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_fk" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "expense_categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_payment_fk" FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "payments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_creator_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "daily_summaries" ADD CONSTRAINT "daily_summaries_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "document_counters" ADD CONSTRAINT "document_counters_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_intake_sessions" ADD CONSTRAINT "ai_intake_sessions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_intake_sessions" ADD CONSTRAINT "ai_intake_sessions_creator_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_intake_sessions" ADD CONSTRAINT "ai_intake_sessions_purchase_fk" FOREIGN KEY ("tenant_id", "confirmed_purchase_id") REFERENCES "purchases"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_intake_items" ADD CONSTRAINT "ai_intake_items_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_intake_items" ADD CONSTRAINT "ai_intake_items_session_fk" FOREIGN KEY ("tenant_id", "session_id") REFERENCES "ai_intake_sessions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_intake_items" ADD CONSTRAINT "ai_intake_items_product_fk" FOREIGN KEY ("tenant_id", "matched_product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


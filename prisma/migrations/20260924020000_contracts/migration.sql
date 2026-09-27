-- Prisma writes updated_at from the client. The database also defaults it so
-- SQL posting, seeds, and triggers can insert a row without omitting the column.
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'updated_at'
      AND column_default IS NULL
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP',
      target.table_name
    );
  END LOOP;
END $$;

-- DukaanOS database contract.
-- Checks, search, immutability, posting consistency, document numbers, and RLS.
-- Application services are not implemented here. These constraints are the
-- rules a later posting transaction must satisfy before COMMIT.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE FUNCTION shop_business_date(p_ts timestamptz, p_tz text)
RETURNS date
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  IF p_ts IS NULL OR p_tz IS NULL OR btrim(p_tz) = '' THEN
    RAISE EXCEPTION 'business date requires a timestamp and shop timezone'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM pg_timezone_names WHERE name = p_tz;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown shop timezone %', p_tz
      USING ERRCODE = '23514';
  END IF;
  RETURN (p_ts AT TIME ZONE p_tz)::date;
END;
$$;

CREATE FUNCTION app_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE FUNCTION app_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- True when this tuple was written by the transaction that is running now.
CREATE FUNCTION dukaan_same_tx(p_xmin xid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT p_xmin = pg_current_xact_id()::xid
$$;

CREATE FUNCTION assign_business_date()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  ts timestamptz;
  tz text;
BEGIN
  ts := (to_jsonb(NEW) ->> TG_ARGV[0])::timestamptz;
  SELECT timezone INTO tz FROM tenants WHERE id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shop is not visible in the current tenant context'
      USING ERRCODE = '42501';
  END IF;
  NEW.business_date := shop_business_date(ts, tz);
  RETURN NEW;
END;
$$;

CREATE FUNCTION reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$$;

CREATE FUNCTION reject_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION '% cannot be deleted', TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$$;

-- ---------------------------------------------------------------------------
-- Column and row checks
-- ---------------------------------------------------------------------------

ALTER TABLE units
  ADD CONSTRAINT units_decimal_places_range CHECK (decimal_places BETWEEN 0 AND 3);

ALTER TABLE products
  ADD CONSTRAINT products_prices_non_negative CHECK (
    (default_purchase_price IS NULL OR default_purchase_price >= 0)
    AND (default_selling_price IS NULL OR default_selling_price >= 0)
    AND (average_cost IS NULL OR average_cost >= 0)
  ),
  ADD CONSTRAINT products_stock_levels CHECK (
    (minimum_stock_level IS NULL OR minimum_stock_level >= 0)
    AND (maximum_stock_level IS NULL OR maximum_stock_level >= 0)
    AND (
      minimum_stock_level IS NULL
      OR maximum_stock_level IS NULL
      OR maximum_stock_level >= minimum_stock_level
    )
  );

ALTER TABLE product_price_history
  ADD CONSTRAINT product_price_history_non_negative CHECK (
    (old_price IS NULL OR old_price >= 0) AND new_price >= 0
  );

ALTER TABLE customer_product_prices
  ADD CONSTRAINT customer_product_prices_non_negative CHECK (selling_price >= 0),
  ADD CONSTRAINT customer_product_prices_window CHECK (
    valid_from IS NULL OR valid_until IS NULL OR valid_until > valid_from
  );

ALTER TABLE customers
  ADD CONSTRAINT customers_opening_non_negative CHECK (opening_balance >= 0),
  ADD CONSTRAINT customers_credit_limit_non_negative CHECK (
    credit_limit IS NULL OR credit_limit >= 0
  );

ALTER TABLE suppliers
  ADD CONSTRAINT suppliers_opening_non_negative CHECK (opening_balance >= 0);

ALTER TABLE devices
  ADD CONSTRAINT devices_revoked_inactive CHECK (revoked_at IS NULL OR is_active = false);

ALTER TABLE inventory_balances
  ADD CONSTRAINT inventory_balances_cost_non_negative CHECK (
    average_cost IS NULL OR average_cost >= 0
  );

ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_cost_non_negative CHECK (
    unit_cost IS NULL OR unit_cost >= 0
  ),
  ADD CONSTRAINT inventory_movements_delta_nonzero CHECK (quantity_delta <> 0),
  ADD CONSTRAINT inventory_movements_sign CHECK (
    (
      movement_type IN ('OPENING_STOCK', 'PURCHASE', 'SALE_RETURN', 'SALE_VOID', 'TRANSFER_IN')
      AND quantity_delta > 0
    )
    OR (
      movement_type IN ('SALE', 'PURCHASE_RETURN', 'DAMAGE', 'EXPIRY', 'TRANSFER_OUT')
      AND quantity_delta < 0
    )
    OR (movement_type = 'ADJUSTMENT' AND quantity_delta <> 0)
  );

ALTER TABLE purchases
  ADD CONSTRAINT purchases_amounts CHECK (
    subtotal >= 0 AND discount_total >= 0 AND tax_total >= 0 AND grand_total >= 0
    AND grand_total = subtotal - discount_total + tax_total
  );

ALTER TABLE purchase_items
  ADD CONSTRAINT purchase_items_amounts CHECK (
    quantity > 0 AND unit_cost >= 0 AND discount_amount >= 0 AND tax_amount >= 0 AND line_total >= 0
  );

ALTER TABLE purchase_returns
  ADD CONSTRAINT purchase_returns_amounts CHECK (
    subtotal >= 0 AND tax_total >= 0 AND grand_total >= 0 AND refund_amount >= 0
    AND grand_total = subtotal + tax_total
    AND refund_amount <= grand_total
    AND status = 'CONFIRMED'
  );

ALTER TABLE purchase_return_items
  ADD CONSTRAINT purchase_return_items_amounts CHECK (
    quantity > 0 AND unit_cost >= 0 AND line_total >= 0
  );

ALTER TABLE sales
  ADD CONSTRAINT sales_amounts CHECK (
    subtotal >= 0 AND discount_total >= 0 AND tax_total >= 0 AND grand_total >= 0
    AND grand_total = subtotal - discount_total + tax_total + round_off
  );

ALTER TABLE sale_items
  ADD CONSTRAINT sale_items_amounts CHECK (
    quantity > 0
    AND unit_selling_price >= 0
    AND (unit_cost IS NULL OR unit_cost >= 0)
    AND discount_amount >= 0
    AND tax_amount >= 0
    AND line_total >= 0
  );

ALTER TABLE sale_returns
  ADD CONSTRAINT sale_returns_amounts CHECK (
    subtotal >= 0 AND refund_amount >= 0 AND refund_amount <= subtotal
    AND status = 'CONFIRMED'
  );

ALTER TABLE sale_return_items
  ADD CONSTRAINT sale_return_items_amounts CHECK (
    quantity > 0
    AND unit_price >= 0
    AND (unit_cost IS NULL OR unit_cost >= 0)
    AND line_total >= 0
  );

ALTER TABLE stock_adjustment_items
  ADD CONSTRAINT stock_adjustment_items_delta CHECK (quantity_delta <> 0),
  ADD CONSTRAINT stock_adjustment_items_cost CHECK (unit_cost IS NULL OR unit_cost >= 0);

ALTER TABLE stock_transfers
  ADD CONSTRAINT stock_transfers_distinct_locations CHECK (from_location_id <> to_location_id);

ALTER TABLE stock_transfer_items
  ADD CONSTRAINT stock_transfer_items_quantity CHECK (quantity > 0);

ALTER TABLE payments
  ADD CONSTRAINT payments_amount_positive CHECK (amount > 0),
  ADD CONSTRAINT payments_reference_shape CHECK (
    (
      reference_type = 'SALE' AND direction = 'IN' AND reference_id IS NOT NULL AND supplier_id IS NULL
    ) OR (
      reference_type = 'SALE_VOID' AND direction = 'OUT' AND reference_id IS NOT NULL AND supplier_id IS NULL
    ) OR (
      reference_type = 'SALE_RETURN' AND direction = 'OUT' AND reference_id IS NOT NULL AND supplier_id IS NULL
    ) OR (
      reference_type = 'CUSTOMER_RECEIPT' AND direction = 'IN' AND reference_id IS NULL
      AND customer_id IS NOT NULL AND supplier_id IS NULL
    ) OR (
      reference_type = 'PURCHASE' AND direction = 'OUT' AND reference_id IS NOT NULL AND customer_id IS NULL
    ) OR (
      reference_type = 'PURCHASE_RETURN' AND direction = 'IN' AND reference_id IS NOT NULL AND customer_id IS NULL
    ) OR (
      reference_type = 'SUPPLIER_PAYMENT' AND direction = 'OUT' AND reference_id IS NULL
      AND supplier_id IS NOT NULL AND customer_id IS NULL
    ) OR (
      reference_type = 'EXPENSE' AND direction = 'OUT' AND reference_id IS NOT NULL
      AND customer_id IS NULL AND supplier_id IS NULL
    )
  );

ALTER TABLE customer_ledger
  ADD CONSTRAINT customer_ledger_one_sided CHECK (
    debit_amount >= 0 AND credit_amount >= 0
    AND (
      (debit_amount > 0 AND credit_amount = 0)
      OR (credit_amount > 0 AND debit_amount = 0)
    )
  ),
  ADD CONSTRAINT customer_ledger_entry_shape CHECK (
    (entry_type = 'OPENING' AND reference_type = 'OPENING_BALANCE' AND reference_id IS NULL AND debit_amount > 0)
    OR (entry_type = 'CREDIT_SALE' AND reference_type = 'SALE' AND reference_id IS NOT NULL AND debit_amount > 0)
    OR (entry_type = 'PAYMENT' AND reference_type = 'CUSTOMER_RECEIPT' AND reference_id IS NOT NULL AND credit_amount > 0)
    OR (entry_type = 'SALE_RETURN' AND reference_type = 'SALE_RETURN' AND reference_id IS NOT NULL AND credit_amount > 0)
    OR (entry_type = 'SALE_VOID' AND reference_type = 'SALE_VOID' AND reference_id IS NOT NULL AND credit_amount > 0)
    OR (entry_type = 'ADJUSTMENT' AND reference_type = 'MANUAL_ADJUSTMENT' AND reference_id IS NULL)
  );

ALTER TABLE supplier_ledger
  ADD CONSTRAINT supplier_ledger_one_sided CHECK (
    debit_amount >= 0 AND credit_amount >= 0
    AND (
      (debit_amount > 0 AND credit_amount = 0)
      OR (credit_amount > 0 AND debit_amount = 0)
    )
  ),
  ADD CONSTRAINT supplier_ledger_entry_shape CHECK (
    (entry_type = 'OPENING' AND reference_type = 'OPENING_BALANCE' AND reference_id IS NULL AND credit_amount > 0)
    OR (entry_type = 'PURCHASE' AND reference_type = 'PURCHASE' AND reference_id IS NOT NULL AND credit_amount > 0)
    OR (entry_type = 'PAYMENT' AND reference_type = 'SUPPLIER_PAYMENT' AND reference_id IS NOT NULL AND debit_amount > 0)
    OR (entry_type = 'PURCHASE_RETURN' AND reference_type = 'PURCHASE_RETURN' AND reference_id IS NOT NULL AND debit_amount > 0)
    OR (entry_type = 'ADJUSTMENT' AND reference_type = 'MANUAL_ADJUSTMENT' AND reference_id IS NULL)
  );

ALTER TABLE expenses
  ADD CONSTRAINT expenses_amount_positive CHECK (amount > 0);

ALTER TABLE document_counters
  ADD CONSTRAINT document_counters_sequence CHECK (
    next_number >= 1 AND pad_width BETWEEN 1 AND 12 AND char_length(prefix) >= 1
  );

ALTER TABLE otp_challenges
  ADD CONSTRAINT otp_challenges_attempts CHECK (attempt_count >= 0);

ALTER TABLE ai_intake_items
  ADD CONSTRAINT ai_intake_items_confidence CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  ADD CONSTRAINT ai_intake_items_suggestions_non_negative CHECK (
    (suggested_quantity IS NULL OR suggested_quantity >= 0)
    AND (suggested_purchase_price IS NULL OR suggested_purchase_price >= 0)
    AND (suggested_selling_price IS NULL OR suggested_selling_price >= 0)
    AND (edited_quantity IS NULL OR edited_quantity >= 0)
    AND (edited_purchase_price IS NULL OR edited_purchase_price >= 0)
    AND (edited_selling_price IS NULL OR edited_selling_price >= 0)
  );

-- ---------------------------------------------------------------------------
-- Partial indexes
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX customers_phone_key
  ON customers (tenant_id, phone)
  WHERE phone IS NOT NULL;

CREATE UNIQUE INDEX suppliers_phone_key
  ON suppliers (tenant_id, phone)
  WHERE phone IS NOT NULL;

CREATE UNIQUE INDEX locations_code_key
  ON locations (tenant_id, code)
  WHERE code IS NOT NULL;

CREATE UNIQUE INDEX locations_one_default_key
  ON locations (tenant_id)
  WHERE is_default;

CREATE UNIQUE INDEX product_barcodes_one_primary_key
  ON product_barcodes (tenant_id, product_id)
  WHERE is_primary;

CREATE UNIQUE INDEX categories_root_name_key
  ON categories (tenant_id, name)
  WHERE parent_id IS NULL;

CREATE UNIQUE INDEX categories_child_name_key
  ON categories (tenant_id, parent_id, name)
  WHERE parent_id IS NOT NULL;

CREATE UNIQUE INDEX purchases_supplier_invoice_key
  ON purchases (tenant_id, supplier_id, supplier_invoice_number)
  WHERE supplier_id IS NOT NULL AND supplier_invoice_number IS NOT NULL;

CREATE UNIQUE INDEX expenses_payment_key
  ON expenses (tenant_id, payment_id)
  WHERE payment_id IS NOT NULL;

CREATE INDEX products_name_trgm ON products USING gin (name gin_trgm_ops) WHERE name IS NOT NULL;
CREATE INDEX products_name_en_trgm ON products USING gin (name_en gin_trgm_ops) WHERE name_en IS NOT NULL;
CREATE INDEX products_name_hi_trgm ON products USING gin (name_hi gin_trgm_ops) WHERE name_hi IS NOT NULL;
CREATE INDEX products_name_mr_trgm ON products USING gin (name_mr gin_trgm_ops) WHERE name_mr IS NOT NULL;
CREATE INDEX customers_name_trgm ON customers USING gin (name gin_trgm_ops) WHERE name IS NOT NULL;
CREATE INDEX suppliers_name_trgm ON suppliers USING gin (name gin_trgm_ops) WHERE name IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Business date, immutability, references
-- ---------------------------------------------------------------------------

CREATE TRIGGER sales_business_date
  BEFORE INSERT OR UPDATE OF sale_date, tenant_id ON sales
  FOR EACH ROW EXECUTE FUNCTION assign_business_date('sale_date');

CREATE TRIGGER purchases_business_date
  BEFORE INSERT OR UPDATE OF purchase_date, tenant_id ON purchases
  FOR EACH ROW EXECUTE FUNCTION assign_business_date('purchase_date');

CREATE TRIGGER sale_returns_business_date
  BEFORE INSERT OR UPDATE OF return_date, tenant_id ON sale_returns
  FOR EACH ROW EXECUTE FUNCTION assign_business_date('return_date');

CREATE TRIGGER purchase_returns_business_date
  BEFORE INSERT OR UPDATE OF return_date, tenant_id ON purchase_returns
  FOR EACH ROW EXECUTE FUNCTION assign_business_date('return_date');

CREATE TRIGGER stock_adjustments_business_date
  BEFORE INSERT OR UPDATE OF adjustment_date, tenant_id ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION assign_business_date('adjustment_date');

CREATE TRIGGER stock_transfers_business_date
  BEFORE INSERT OR UPDATE OF transfer_date, tenant_id ON stock_transfers
  FOR EACH ROW EXECUTE FUNCTION assign_business_date('transfer_date');

CREATE TRIGGER payments_business_date
  BEFORE INSERT OR UPDATE OF payment_date, tenant_id ON payments
  FOR EACH ROW EXECUTE FUNCTION assign_business_date('payment_date');

CREATE TRIGGER expenses_business_date
  BEFORE INSERT OR UPDATE OF expense_date, tenant_id ON expenses
  FOR EACH ROW EXECUTE FUNCTION assign_business_date('expense_date');

CREATE TRIGGER inventory_movements_business_date
  BEFORE INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION assign_business_date('occurred_at');

CREATE TRIGGER inventory_movements_append_only
  BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER customer_ledger_append_only
  BEFORE UPDATE OR DELETE ON customer_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER supplier_ledger_append_only
  BEFORE UPDATE OR DELETE ON supplier_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER payments_append_only
  BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER sale_items_append_only
  BEFORE UPDATE OR DELETE ON sale_items
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER sale_return_items_append_only
  BEFORE UPDATE OR DELETE ON sale_return_items
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER purchase_return_items_append_only
  BEFORE UPDATE OR DELETE ON purchase_return_items
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER product_price_history_append_only
  BEFORE UPDATE OR DELETE ON product_price_history
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER sales_no_delete
  BEFORE DELETE ON sales
  FOR EACH ROW EXECUTE FUNCTION reject_delete();

CREATE TRIGGER purchases_no_delete
  BEFORE DELETE ON purchases
  FOR EACH ROW EXECUTE FUNCTION reject_delete();

CREATE TRIGGER sale_returns_no_delete
  BEFORE DELETE ON sale_returns
  FOR EACH ROW EXECUTE FUNCTION reject_delete();

CREATE TRIGGER purchase_returns_no_delete
  BEFORE DELETE ON purchase_returns
  FOR EACH ROW EXECUTE FUNCTION reject_delete();

CREATE TRIGGER stock_adjustments_no_delete
  BEFORE DELETE ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION reject_delete();

CREATE TRIGGER stock_transfers_no_delete
  BEFORE DELETE ON stock_transfers
  FOR EACH ROW EXECUTE FUNCTION reject_delete();

CREATE FUNCTION protect_sale_header()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
     OR NEW.location_id <> OLD.location_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.bill_number <> OLD.bill_number
     OR NEW.created_by <> OLD.created_by
     OR NEW.sale_date <> OLD.sale_date
  THEN
    RAISE EXCEPTION 'sale identity fields are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'VOIDED' THEN
    RAISE EXCEPTION 'voided sale is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NOT dukaan_same_tx(OLD.xmin) THEN
    IF NEW.subtotal <> OLD.subtotal
       OR NEW.discount_total <> OLD.discount_total
       OR NEW.tax_total <> OLD.tax_total
       OR NEW.round_off <> OLD.round_off
       OR NEW.grand_total <> OLD.grand_total
    THEN
      RAISE EXCEPTION 'posted sale amounts are immutable'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'COMPLETED' AND NEW.status IS DISTINCT FROM 'VOIDED' AND NEW.status IS DISTINCT FROM 'COMPLETED' THEN
      RAISE EXCEPTION 'invalid sale status transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_protect_header
  BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION protect_sale_header();

CREATE FUNCTION protect_posted_header()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION '% identity fields are immutable', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'CANCELLED' THEN
    RAISE EXCEPTION '% is cancelled and immutable', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'CONFIRMED' AND NEW.status IS DISTINCT FROM 'CONFIRMED' THEN
    RAISE EXCEPTION 'confirmed % cannot change status; post a reversing document', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'CONFIRMED' AND NOT dukaan_same_tx(OLD.xmin) THEN
    IF to_jsonb(NEW) - 'status' - 'notes' - 'updated_at' - 'business_date'
       IS DISTINCT FROM
       to_jsonb(OLD) - 'status' - 'notes' - 'updated_at' - 'business_date'
    THEN
      RAISE EXCEPTION 'confirmed % amounts are immutable', TG_TABLE_NAME
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER purchases_protect_header
  BEFORE UPDATE ON purchases
  FOR EACH ROW EXECUTE FUNCTION protect_posted_header();

CREATE TRIGGER stock_adjustments_protect_header
  BEFORE UPDATE ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION protect_posted_header();

CREATE TRIGGER stock_transfers_protect_header
  BEFORE UPDATE ON stock_transfers
  FOR EACH ROW EXECUTE FUNCTION protect_posted_header();

CREATE FUNCTION draft_lines_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  parent_status document_status;
  row_data jsonb;
  parent_id uuid;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  parent_id := (row_data ->> TG_ARGV[1])::uuid;

  EXECUTE format(
    'SELECT status FROM %I WHERE id = $1 AND tenant_id = $2',
    TG_ARGV[0]
  )
  INTO parent_status
  USING parent_id, (row_data ->> 'tenant_id')::uuid;

  IF parent_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION '% can change only while the document is a draft', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_items_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_items
  FOR EACH ROW EXECUTE FUNCTION draft_lines_only('purchases', 'purchase_id');

CREATE TRIGGER stock_adjustment_items_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON stock_adjustment_items
  FOR EACH ROW EXECUTE FUNCTION draft_lines_only('stock_adjustments', 'stock_adjustment_id');

CREATE TRIGGER stock_transfer_items_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON stock_transfer_items
  FOR EACH ROW EXECUTE FUNCTION draft_lines_only('stock_transfers', 'stock_transfer_id');

CREATE FUNCTION assert_movement_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  ok boolean;
BEGIN
  IF NEW.reference_type NOT IN (
    'SALE', 'SALE_VOID', 'SALE_RETURN', 'PURCHASE', 'PURCHASE_RETURN',
    'STOCK_ADJUSTMENT', 'STOCK_TRANSFER'
  ) THEN
    RAISE EXCEPTION 'inventory movement cannot reference %', NEW.reference_type
      USING ERRCODE = '23514';
  END IF;

  IF NEW.reference_type IN ('SALE', 'SALE_VOID') THEN
    SELECT EXISTS (
      SELECT 1 FROM sale_items
      WHERE id = NEW.source_line_id AND sale_id = NEW.reference_id
        AND tenant_id = NEW.tenant_id AND product_id = NEW.product_id
    ) INTO ok;
  ELSIF NEW.reference_type = 'SALE_RETURN' THEN
    SELECT EXISTS (
      SELECT 1 FROM sale_return_items
      WHERE id = NEW.source_line_id AND sale_return_id = NEW.reference_id
        AND tenant_id = NEW.tenant_id AND product_id = NEW.product_id
    ) INTO ok;
  ELSIF NEW.reference_type = 'PURCHASE' THEN
    SELECT EXISTS (
      SELECT 1 FROM purchase_items
      WHERE id = NEW.source_line_id AND purchase_id = NEW.reference_id
        AND tenant_id = NEW.tenant_id AND product_id = NEW.product_id
    ) INTO ok;
  ELSIF NEW.reference_type = 'PURCHASE_RETURN' THEN
    SELECT EXISTS (
      SELECT 1 FROM purchase_return_items
      WHERE id = NEW.source_line_id AND purchase_return_id = NEW.reference_id
        AND tenant_id = NEW.tenant_id AND product_id = NEW.product_id
    ) INTO ok;
  ELSIF NEW.reference_type = 'STOCK_ADJUSTMENT' THEN
    SELECT EXISTS (
      SELECT 1 FROM stock_adjustment_items
      WHERE id = NEW.source_line_id AND stock_adjustment_id = NEW.reference_id
        AND tenant_id = NEW.tenant_id AND product_id = NEW.product_id
    ) INTO ok;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM stock_transfer_items
      WHERE id = NEW.source_line_id AND stock_transfer_id = NEW.reference_id
        AND tenant_id = NEW.tenant_id AND product_id = NEW.product_id
    ) INTO ok;
  END IF;

  IF NOT ok THEN
    RAISE EXCEPTION 'movement source line does not belong to the referenced document'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_movements_source
  BEFORE INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION assert_movement_source();

CREATE FUNCTION assert_polymorphic_reference()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  ok boolean := true;
BEGIN
  IF NEW.reference_id IS NULL THEN
    RETURN NEW;
  END IF;

  CASE NEW.reference_type
    WHEN 'SALE', 'SALE_VOID' THEN
      SELECT EXISTS (
        SELECT 1 FROM sales WHERE id = NEW.reference_id AND tenant_id = NEW.tenant_id
      ) INTO ok;
    WHEN 'SALE_RETURN' THEN
      SELECT EXISTS (
        SELECT 1 FROM sale_returns WHERE id = NEW.reference_id AND tenant_id = NEW.tenant_id
      ) INTO ok;
    WHEN 'PURCHASE' THEN
      SELECT EXISTS (
        SELECT 1 FROM purchases WHERE id = NEW.reference_id AND tenant_id = NEW.tenant_id
      ) INTO ok;
    WHEN 'PURCHASE_RETURN' THEN
      SELECT EXISTS (
        SELECT 1 FROM purchase_returns WHERE id = NEW.reference_id AND tenant_id = NEW.tenant_id
      ) INTO ok;
    WHEN 'STOCK_ADJUSTMENT' THEN
      SELECT EXISTS (
        SELECT 1 FROM stock_adjustments WHERE id = NEW.reference_id AND tenant_id = NEW.tenant_id
      ) INTO ok;
    WHEN 'STOCK_TRANSFER' THEN
      SELECT EXISTS (
        SELECT 1 FROM stock_transfers WHERE id = NEW.reference_id AND tenant_id = NEW.tenant_id
      ) INTO ok;
    WHEN 'EXPENSE' THEN
      SELECT EXISTS (
        SELECT 1 FROM expenses WHERE id = NEW.reference_id AND tenant_id = NEW.tenant_id
      ) INTO ok;
    WHEN 'CUSTOMER_RECEIPT' THEN
      SELECT EXISTS (
        SELECT 1 FROM payments
        WHERE id = NEW.reference_id AND tenant_id = NEW.tenant_id
          AND direction = 'IN' AND customer_id = NEW.customer_id
      ) INTO ok;
    WHEN 'SUPPLIER_PAYMENT' THEN
      SELECT EXISTS (
        SELECT 1 FROM payments
        WHERE id = NEW.reference_id AND tenant_id = NEW.tenant_id
          AND direction = 'OUT' AND supplier_id = NEW.supplier_id
      ) INTO ok;
    ELSE
      ok := true;
  END CASE;

  IF NOT ok THEN
    RAISE EXCEPTION 'reference % % is not in this shop', NEW.reference_type, NEW.reference_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_reference
  BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION assert_polymorphic_reference();

CREATE TRIGGER customer_ledger_reference
  BEFORE INSERT ON customer_ledger
  FOR EACH ROW EXECUTE FUNCTION assert_polymorphic_reference();

CREATE TRIGGER supplier_ledger_reference
  BEFORE INSERT ON supplier_ledger
  FOR EACH ROW EXECUTE FUNCTION assert_polymorphic_reference();

CREATE FUNCTION enforce_sale_return_quantity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  sold numeric(18,3);
  already numeric(18,3);
  sale_id uuid;
  sale_status sale_status;
  item_product uuid;
  item_cost numeric(18,2);
  return_sale uuid;
BEGIN
  SELECT si.quantity, si.sale_id, s.status, si.product_id, si.unit_cost
    INTO sold, sale_id, sale_status, item_product, item_cost
  FROM sale_items si
  JOIN sales s ON s.id = si.sale_id AND s.tenant_id = si.tenant_id
  WHERE si.id = NEW.original_sale_item_id AND si.tenant_id = NEW.tenant_id;

  IF sold IS NULL THEN
    RAISE EXCEPTION 'original sale line is not in this shop'
      USING ERRCODE = '23514';
  END IF;

  SELECT original_sale_id INTO return_sale
  FROM sale_returns
  WHERE id = NEW.sale_return_id AND tenant_id = NEW.tenant_id;

  IF return_sale IS DISTINCT FROM sale_id THEN
    RAISE EXCEPTION 'return line does not belong to the original sale'
      USING ERRCODE = '23514';
  END IF;

  IF sale_status = 'VOIDED' THEN
    RAISE EXCEPTION 'voided sale cannot be returned'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.product_id IS DISTINCT FROM item_product THEN
    RAISE EXCEPTION 'return product does not match the sold product'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.unit_cost IS DISTINCT FROM item_cost THEN
    RAISE EXCEPTION 'return must keep the original sale cost'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(sri.quantity), 0) INTO already
  FROM sale_return_items sri
  JOIN sale_returns sr ON sr.id = sri.sale_return_id AND sr.tenant_id = sri.tenant_id
  WHERE sri.original_sale_item_id = NEW.original_sale_item_id
    AND sri.tenant_id = NEW.tenant_id
    AND sr.status = 'CONFIRMED'
    AND sri.id <> NEW.id;

  IF already + NEW.quantity > sold THEN
    RAISE EXCEPTION 'return quantity exceeds quantity sold'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER sale_return_items_quantity
  BEFORE INSERT ON sale_return_items
  FOR EACH ROW EXECUTE FUNCTION enforce_sale_return_quantity();

CREATE FUNCTION enforce_purchase_return_quantity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  bought numeric(18,3);
  already numeric(18,3);
  purchase_id uuid;
  purchase_status document_status;
  item_product uuid;
  item_cost numeric(18,2);
  return_purchase uuid;
BEGIN
  SELECT pi.quantity, pi.purchase_id, p.status, pi.product_id, pi.unit_cost
    INTO bought, purchase_id, purchase_status, item_product, item_cost
  FROM purchase_items pi
  JOIN purchases p ON p.id = pi.purchase_id AND p.tenant_id = pi.tenant_id
  WHERE pi.id = NEW.original_purchase_item_id AND pi.tenant_id = NEW.tenant_id;

  IF bought IS NULL THEN
    RAISE EXCEPTION 'original purchase line is not in this shop'
      USING ERRCODE = '23514';
  END IF;

  IF purchase_status IS DISTINCT FROM 'CONFIRMED' THEN
    RAISE EXCEPTION 'only a confirmed purchase can be returned'
      USING ERRCODE = '23514';
  END IF;

  SELECT original_purchase_id INTO return_purchase
  FROM purchase_returns
  WHERE id = NEW.purchase_return_id AND tenant_id = NEW.tenant_id;

  IF return_purchase IS DISTINCT FROM purchase_id THEN
    RAISE EXCEPTION 'return line does not belong to the original purchase'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.product_id IS DISTINCT FROM item_product OR NEW.unit_cost IS DISTINCT FROM item_cost THEN
    RAISE EXCEPTION 'purchase return must keep the original product and cost'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(pri.quantity), 0) INTO already
  FROM purchase_return_items pri
  WHERE pri.original_purchase_item_id = NEW.original_purchase_item_id
    AND pri.tenant_id = NEW.tenant_id
    AND pri.id <> NEW.id;

  IF already + NEW.quantity > bought THEN
    RAISE EXCEPTION 'purchase return quantity exceeds quantity purchased'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_return_items_quantity
  BEFORE INSERT ON purchase_return_items
  FOR EACH ROW EXECUTE FUNCTION enforce_purchase_return_quantity();

CREATE FUNCTION enforce_balance_rules()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  allow_negative boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.tenant_id <> OLD.tenant_id
    OR NEW.product_id <> OLD.product_id
    OR NEW.location_id <> OLD.location_id
  ) THEN
    RAISE EXCEPTION 'inventory balance identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  SELECT negative_stock_allowed INTO allow_negative
  FROM tenants WHERE id = NEW.tenant_id;

  IF NOT COALESCE(allow_negative, false) AND NEW.quantity < 0 THEN
    RAISE EXCEPTION 'negative stock is not allowed for this shop'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_balances_rules
  BEFORE INSERT OR UPDATE ON inventory_balances
  FOR EACH ROW EXECUTE FUNCTION enforce_balance_rules();

-- ---------------------------------------------------------------------------
-- Deferred posting consistency
-- ---------------------------------------------------------------------------

CREATE FUNCTION dukaan_assert_balance(p_tenant uuid, p_product uuid, p_location uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  moved numeric(18,3);
  on_hand numeric(18,3);
  balance_exists boolean;
BEGIN
  SELECT COALESCE(SUM(quantity_delta), 0) INTO moved
  FROM inventory_movements
  WHERE tenant_id = p_tenant AND product_id = p_product AND location_id = p_location;

  SELECT quantity INTO on_hand
  FROM inventory_balances
  WHERE tenant_id = p_tenant AND product_id = p_product AND location_id = p_location;
  balance_exists := FOUND;

  IF NOT balance_exists AND moved <> 0 THEN
    RAISE EXCEPTION 'stock movements for product % have no balance row', p_product
      USING ERRCODE = '23514';
  END IF;

  IF balance_exists AND on_hand IS DISTINCT FROM moved THEN
    RAISE EXCEPTION 'on-hand quantity % does not match movement total %', on_hand, moved
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION reconcile_movement_balance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM dukaan_assert_balance(NEW.tenant_id, NEW.product_id, NEW.location_id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION reconcile_balance_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM dukaan_assert_balance(NEW.tenant_id, NEW.product_id, NEW.location_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER inventory_movements_reconcile
  AFTER INSERT ON inventory_movements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION reconcile_movement_balance();

CREATE CONSTRAINT TRIGGER inventory_balances_reconcile
  AFTER INSERT OR UPDATE ON inventory_balances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION reconcile_balance_row();

CREATE FUNCTION dukaan_assert_customer(p_tenant uuid, p_customer uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  net numeric(18,2);
  opening_net numeric(18,2);
  cached numeric(18,2);
  opening_cached numeric(18,2);
BEGIN
  SELECT receivable_balance, opening_balance
    INTO cached, opening_cached
  FROM customers
  WHERE id = p_customer AND tenant_id = p_tenant;

  SELECT
    COALESCE(SUM(debit_amount - credit_amount), 0),
    COALESCE(SUM(debit_amount - credit_amount) FILTER (WHERE entry_type = 'OPENING'), 0)
    INTO net, opening_net
  FROM customer_ledger
  WHERE tenant_id = p_tenant AND customer_id = p_customer;

  IF cached IS DISTINCT FROM net OR opening_cached IS DISTINCT FROM opening_net THEN
    RAISE EXCEPTION 'customer receivable cache does not match the ledger'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION dukaan_assert_supplier(p_tenant uuid, p_supplier uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  net numeric(18,2);
  opening_net numeric(18,2);
  cached numeric(18,2);
  opening_cached numeric(18,2);
BEGIN
  SELECT payable_balance, opening_balance
    INTO cached, opening_cached
  FROM suppliers
  WHERE id = p_supplier AND tenant_id = p_tenant;

  SELECT
    COALESCE(SUM(credit_amount - debit_amount), 0),
    COALESCE(SUM(credit_amount - debit_amount) FILTER (WHERE entry_type = 'OPENING'), 0)
    INTO net, opening_net
  FROM supplier_ledger
  WHERE tenant_id = p_tenant AND supplier_id = p_supplier;

  IF cached IS DISTINCT FROM net OR opening_cached IS DISTINCT FROM opening_net THEN
    RAISE EXCEPTION 'supplier payable cache does not match the ledger'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION reconcile_customer_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM dukaan_assert_customer(NEW.tenant_id, NEW.id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION reconcile_customer_ledger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM dukaan_assert_customer(NEW.tenant_id, NEW.customer_id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION reconcile_supplier_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM dukaan_assert_supplier(NEW.tenant_id, NEW.id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION reconcile_supplier_ledger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM dukaan_assert_supplier(NEW.tenant_id, NEW.supplier_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER customers_reconcile
  AFTER INSERT OR UPDATE ON customers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION reconcile_customer_row();

CREATE CONSTRAINT TRIGGER customer_ledger_reconcile
  AFTER INSERT ON customer_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION reconcile_customer_ledger();

CREATE CONSTRAINT TRIGGER suppliers_reconcile
  AFTER INSERT OR UPDATE ON suppliers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION reconcile_supplier_row();

CREATE CONSTRAINT TRIGGER supplier_ledger_reconcile
  AFTER INSERT ON supplier_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION reconcile_supplier_ledger();

CREATE FUNCTION dukaan_assert_sale(p_sale uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  sale sales%ROWTYPE;
  line_net numeric(18,2);
  line_discount numeric(18,2);
  line_tax numeric(18,2);
  line_count integer;
  missing integer;
  paid numeric(18,2);
  credit numeric(18,2);
  refunded numeric(18,2);
  void_credit numeric(18,2);
BEGIN
  SELECT * INTO sale FROM sales WHERE id = p_sale;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COUNT(*), COALESCE(SUM(line_total), 0), COALESCE(SUM(discount_amount), 0), COALESCE(SUM(tax_amount), 0)
    INTO line_count, line_net, line_discount, line_tax
  FROM sale_items
  WHERE sale_id = sale.id AND tenant_id = sale.tenant_id;

  IF line_count = 0 THEN
    RAISE EXCEPTION 'sale % has no lines', sale.bill_number
      USING ERRCODE = '23514';
  END IF;

  IF line_net IS DISTINCT FROM (sale.subtotal - sale.discount_total)
     OR line_discount IS DISTINCT FROM sale.discount_total
     OR line_tax IS DISTINCT FROM sale.tax_total
  THEN
    RAISE EXCEPTION 'sale % totals do not match its lines', sale.bill_number
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO missing
  FROM sale_items si
  WHERE si.sale_id = sale.id AND si.tenant_id = sale.tenant_id
    AND NOT EXISTS (
      SELECT 1 FROM inventory_movements m
      WHERE m.tenant_id = si.tenant_id
        AND m.source_line_id = si.id
        AND m.reference_type = 'SALE'
        AND m.reference_id = sale.id
        AND m.movement_type = 'SALE'
        AND m.product_id = si.product_id
        AND m.location_id = sale.location_id
        AND m.quantity_delta = -si.quantity
        AND m.unit_cost IS NOT DISTINCT FROM si.unit_cost
        AND m.business_date = sale.business_date
    );
  IF missing <> 0 THEN
    RAISE EXCEPTION 'sale % is missing stock movements', sale.bill_number
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO paid
  FROM payments
  WHERE tenant_id = sale.tenant_id AND reference_type = 'SALE' AND reference_id = sale.id AND direction = 'IN';

  SELECT COALESCE(SUM(debit_amount), 0) INTO credit
  FROM customer_ledger
  WHERE tenant_id = sale.tenant_id AND entry_type = 'CREDIT_SALE' AND reference_id = sale.id;

  IF sale.status = 'COMPLETED' THEN
    IF paid + credit IS DISTINCT FROM sale.grand_total THEN
      RAISE EXCEPTION 'sale % payments plus credit do not equal the bill total', sale.bill_number
        USING ERRCODE = '23514';
    END IF;
    IF credit > 0 AND sale.customer_id IS NULL THEN
      RAISE EXCEPTION 'credit sale % requires a customer', sale.bill_number
        USING ERRCODE = '23514';
    END IF;
    IF sale.customer_id IS NULL AND credit <> 0 THEN
      RAISE EXCEPTION 'walk-in sale % cannot carry credit', sale.bill_number
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF sale.status = 'VOIDED' THEN
    SELECT COUNT(*) INTO missing
    FROM sale_items si
    WHERE si.sale_id = sale.id AND si.tenant_id = sale.tenant_id
      AND NOT EXISTS (
        SELECT 1 FROM inventory_movements m
        WHERE m.tenant_id = si.tenant_id
          AND m.source_line_id = si.id
          AND m.reference_type = 'SALE_VOID'
          AND m.reference_id = sale.id
          AND m.movement_type = 'SALE_VOID'
          AND m.quantity_delta = si.quantity
          AND m.unit_cost IS NOT DISTINCT FROM si.unit_cost
      );
    IF missing <> 0 THEN
      RAISE EXCEPTION 'voided sale % is missing reversing stock movements', sale.bill_number
        USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(SUM(amount), 0) INTO refunded
    FROM payments
    WHERE tenant_id = sale.tenant_id AND reference_type = 'SALE_VOID' AND reference_id = sale.id AND direction = 'OUT';

    SELECT COALESCE(SUM(credit_amount), 0) INTO void_credit
    FROM customer_ledger
    WHERE tenant_id = sale.tenant_id AND entry_type = 'SALE_VOID' AND reference_id = sale.id;

    IF paid IS DISTINCT FROM refunded OR credit IS DISTINCT FROM void_credit THEN
      RAISE EXCEPTION 'voided sale % is not fully reversed', sale.bill_number
        USING ERRCODE = '23514';
    END IF;
  END IF;
END;
$$;

CREATE FUNCTION assert_sale_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM dukaan_assert_sale(NEW.id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION assert_sale_from_line()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM dukaan_assert_sale(NEW.sale_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER sales_consistent
  AFTER INSERT OR UPDATE ON sales
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_sale_row();

CREATE CONSTRAINT TRIGGER sale_items_consistent
  AFTER INSERT ON sale_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_sale_from_line();

CREATE FUNCTION dukaan_assert_purchase(p_purchase uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  doc purchases%ROWTYPE;
  line_net numeric(18,2);
  line_discount numeric(18,2);
  line_tax numeric(18,2);
  line_count integer;
  missing integer;
  paid numeric(18,2);
  credit numeric(18,2);
BEGIN
  SELECT * INTO doc FROM purchases WHERE id = p_purchase;
  IF NOT FOUND OR doc.status <> 'CONFIRMED' THEN
    RETURN;
  END IF;

  SELECT COUNT(*), COALESCE(SUM(line_total), 0), COALESCE(SUM(discount_amount), 0), COALESCE(SUM(tax_amount), 0)
    INTO line_count, line_net, line_discount, line_tax
  FROM purchase_items
  WHERE purchase_id = doc.id AND tenant_id = doc.tenant_id;

  IF line_count = 0
     OR line_net IS DISTINCT FROM (doc.subtotal - doc.discount_total)
     OR line_discount IS DISTINCT FROM doc.discount_total
     OR line_tax IS DISTINCT FROM doc.tax_total
  THEN
    RAISE EXCEPTION 'confirmed purchase % does not match its lines', doc.bill_number
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO missing
  FROM purchase_items pi
  WHERE pi.purchase_id = doc.id AND pi.tenant_id = doc.tenant_id
    AND NOT EXISTS (
      SELECT 1 FROM inventory_movements m
      WHERE m.tenant_id = pi.tenant_id
        AND m.source_line_id = pi.id
        AND m.reference_type = 'PURCHASE'
        AND m.reference_id = doc.id
        AND m.movement_type = 'PURCHASE'
        AND m.product_id = pi.product_id
        AND m.location_id = doc.location_id
        AND m.quantity_delta = pi.quantity
        AND m.unit_cost = pi.unit_cost
        AND m.business_date = doc.business_date
    );
  IF missing <> 0 THEN
    RAISE EXCEPTION 'confirmed purchase % is missing stock movements', doc.bill_number
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO paid
  FROM payments
  WHERE tenant_id = doc.tenant_id AND reference_type = 'PURCHASE' AND reference_id = doc.id AND direction = 'OUT';

  SELECT COALESCE(SUM(credit_amount), 0) INTO credit
  FROM supplier_ledger
  WHERE tenant_id = doc.tenant_id AND entry_type = 'PURCHASE' AND reference_id = doc.id;

  IF paid + credit IS DISTINCT FROM doc.grand_total THEN
    RAISE EXCEPTION 'purchase % payments plus payable do not equal the bill total', doc.bill_number
      USING ERRCODE = '23514';
  END IF;
  IF credit > 0 AND doc.supplier_id IS NULL THEN
    RAISE EXCEPTION 'credit purchase % requires a supplier', doc.bill_number
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION assert_purchase_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM dukaan_assert_purchase(NEW.id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER purchases_consistent
  AFTER INSERT OR UPDATE ON purchases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_purchase_row();

CREATE FUNCTION dukaan_assert_adjustment(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  doc stock_adjustments%ROWTYPE;
  missing integer;
  expected movement_type;
BEGIN
  SELECT * INTO doc FROM stock_adjustments WHERE id = p_id;
  IF NOT FOUND OR doc.status <> 'CONFIRMED' THEN
    RETURN;
  END IF;

  expected := CASE doc.reason
    WHEN 'OPENING' THEN 'OPENING_STOCK'::movement_type
    WHEN 'DAMAGE' THEN 'DAMAGE'::movement_type
    WHEN 'EXPIRY' THEN 'EXPIRY'::movement_type
    ELSE 'ADJUSTMENT'::movement_type
  END;

  IF NOT EXISTS (
    SELECT 1 FROM stock_adjustment_items WHERE stock_adjustment_id = doc.id
  ) THEN
    RAISE EXCEPTION 'confirmed adjustment % has no lines', doc.adjustment_number
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO missing
  FROM stock_adjustment_items i
  WHERE i.stock_adjustment_id = doc.id AND i.tenant_id = doc.tenant_id
    AND NOT EXISTS (
      SELECT 1 FROM inventory_movements m
      WHERE m.tenant_id = i.tenant_id
        AND m.source_line_id = i.id
        AND m.reference_type = 'STOCK_ADJUSTMENT'
        AND m.reference_id = doc.id
        AND m.movement_type = expected
        AND m.product_id = i.product_id
        AND m.location_id = doc.location_id
        AND m.quantity_delta = i.quantity_delta
        AND m.unit_cost IS NOT DISTINCT FROM i.unit_cost
        AND m.business_date = doc.business_date
    );
  IF missing <> 0 THEN
    RAISE EXCEPTION 'confirmed adjustment % is missing stock movements', doc.adjustment_number
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION assert_adjustment_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM dukaan_assert_adjustment(NEW.id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER stock_adjustments_consistent
  AFTER INSERT OR UPDATE ON stock_adjustments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_adjustment_row();

CREATE FUNCTION dukaan_assert_transfer(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  doc stock_transfers%ROWTYPE;
  missing integer;
BEGIN
  SELECT * INTO doc FROM stock_transfers WHERE id = p_id;
  IF NOT FOUND OR doc.status <> 'CONFIRMED' THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM stock_transfer_items WHERE stock_transfer_id = doc.id) THEN
    RAISE EXCEPTION 'confirmed transfer % has no lines', doc.transfer_number
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO missing
  FROM stock_transfer_items i
  WHERE i.stock_transfer_id = doc.id
    AND (
      NOT EXISTS (
        SELECT 1 FROM inventory_movements m
        WHERE m.source_line_id = i.id AND m.tenant_id = i.tenant_id
          AND m.movement_type = 'TRANSFER_OUT' AND m.location_id = doc.from_location_id
          AND m.quantity_delta = -i.quantity AND m.reference_id = doc.id
          AND m.business_date = doc.business_date
      )
      OR NOT EXISTS (
        SELECT 1 FROM inventory_movements m
        WHERE m.source_line_id = i.id AND m.tenant_id = i.tenant_id
          AND m.movement_type = 'TRANSFER_IN' AND m.location_id = doc.to_location_id
          AND m.quantity_delta = i.quantity AND m.reference_id = doc.id
          AND m.business_date = doc.business_date
      )
    );
  IF missing <> 0 THEN
    RAISE EXCEPTION 'confirmed transfer % is missing stock movements', doc.transfer_number
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION assert_transfer_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM dukaan_assert_transfer(NEW.id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER stock_transfers_consistent
  AFTER INSERT OR UPDATE ON stock_transfers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_transfer_row();

CREATE FUNCTION dukaan_assert_sale_return(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  doc sale_returns%ROWTYPE;
  line_net numeric(18,2);
  missing integer;
  refunded numeric(18,2);
  credited numeric(18,2);
BEGIN
  SELECT * INTO doc FROM sale_returns WHERE id = p_id;
  IF NOT FOUND OR doc.status <> 'CONFIRMED' THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(line_total), 0) INTO line_net
  FROM sale_return_items
  WHERE sale_return_id = doc.id AND tenant_id = doc.tenant_id;

  IF line_net IS DISTINCT FROM doc.subtotal THEN
    RAISE EXCEPTION 'sale return % total does not match its lines', doc.return_number
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO missing
  FROM sale_return_items i
  WHERE i.sale_return_id = doc.id
    AND NOT EXISTS (
      SELECT 1 FROM inventory_movements m
      WHERE m.source_line_id = i.id AND m.tenant_id = i.tenant_id
        AND m.movement_type = 'SALE_RETURN' AND m.reference_type = 'SALE_RETURN'
        AND m.reference_id = doc.id AND m.location_id = doc.location_id
        AND m.quantity_delta = i.quantity
        AND m.unit_cost IS NOT DISTINCT FROM i.unit_cost
        AND m.business_date = doc.business_date
    );
  IF missing <> 0 THEN
    RAISE EXCEPTION 'sale return % is missing stock movements', doc.return_number
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO refunded
  FROM payments
  WHERE tenant_id = doc.tenant_id AND reference_type = 'SALE_RETURN' AND reference_id = doc.id AND direction = 'OUT';

  SELECT COALESCE(SUM(credit_amount), 0) INTO credited
  FROM customer_ledger
  WHERE tenant_id = doc.tenant_id AND entry_type = 'SALE_RETURN' AND reference_id = doc.id;

  IF refunded IS DISTINCT FROM doc.refund_amount OR refunded + credited IS DISTINCT FROM doc.subtotal THEN
    RAISE EXCEPTION 'sale return % refund and receivable credit do not match', doc.return_number
      USING ERRCODE = '23514';
  END IF;
  IF credited > 0 AND doc.customer_id IS NULL THEN
    RAISE EXCEPTION 'sale return % credit requires a customer', doc.return_number
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION assert_sale_return_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM dukaan_assert_sale_return(NEW.id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER sale_returns_consistent
  AFTER INSERT OR UPDATE ON sale_returns
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_sale_return_row();

CREATE FUNCTION dukaan_assert_purchase_return(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  doc purchase_returns%ROWTYPE;
  line_net numeric(18,2);
  missing integer;
  refunded numeric(18,2);
  debited numeric(18,2);
BEGIN
  SELECT * INTO doc FROM purchase_returns WHERE id = p_id;
  IF NOT FOUND OR doc.status <> 'CONFIRMED' THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(line_total), 0) INTO line_net
  FROM purchase_return_items
  WHERE purchase_return_id = doc.id;

  IF line_net IS DISTINCT FROM doc.grand_total THEN
    RAISE EXCEPTION 'purchase return % total does not match its lines', doc.return_number
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO missing
  FROM purchase_return_items i
  WHERE i.purchase_return_id = doc.id
    AND NOT EXISTS (
      SELECT 1 FROM inventory_movements m
      WHERE m.source_line_id = i.id AND m.tenant_id = i.tenant_id
        AND m.movement_type = 'PURCHASE_RETURN' AND m.reference_id = doc.id
        AND m.location_id = doc.location_id AND m.quantity_delta = -i.quantity
        AND m.unit_cost = i.unit_cost AND m.business_date = doc.business_date
    );
  IF missing <> 0 THEN
    RAISE EXCEPTION 'purchase return % is missing stock movements', doc.return_number
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO refunded
  FROM payments
  WHERE tenant_id = doc.tenant_id AND reference_type = 'PURCHASE_RETURN' AND reference_id = doc.id;

  SELECT COALESCE(SUM(debit_amount), 0) INTO debited
  FROM supplier_ledger
  WHERE tenant_id = doc.tenant_id AND entry_type = 'PURCHASE_RETURN' AND reference_id = doc.id;

  IF refunded IS DISTINCT FROM doc.refund_amount OR refunded + debited IS DISTINCT FROM doc.grand_total THEN
    RAISE EXCEPTION 'purchase return % refund and payable debit do not match', doc.return_number
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION assert_purchase_return_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM dukaan_assert_purchase_return(NEW.id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER purchase_returns_consistent
  AFTER INSERT OR UPDATE ON purchase_returns
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_purchase_return_row();

-- ---------------------------------------------------------------------------
-- Document numbers. Lock the counter row so two bills cannot share a number.
-- ---------------------------------------------------------------------------

CREATE FUNCTION next_document_number(p_tenant_id uuid, p_document_type document_type)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_prefix text;
  v_next integer;
  v_pad integer;
BEGIN
  SELECT prefix, next_number, pad_width
    INTO v_prefix, v_next, v_pad
  FROM document_counters
  WHERE tenant_id = p_tenant_id AND document_type = p_document_type
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'document counter % is not set up for this shop', p_document_type
      USING ERRCODE = '23514';
  END IF;

  UPDATE document_counters
  SET next_number = next_number + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE tenant_id = p_tenant_id AND document_type = p_document_type;

  RETURN v_prefix || lpad(v_next::text, v_pad, '0');
END;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dukaan_app') THEN
    CREATE ROLE dukaan_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT dukaan_app TO CURRENT_USER;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'devices', 'units', 'categories', 'brands', 'products', 'product_barcodes',
    'product_price_history', 'customers', 'customer_product_prices', 'suppliers',
    'locations', 'inventory_balances', 'inventory_movements', 'purchases',
    'purchase_items', 'purchase_returns', 'purchase_return_items', 'sales',
    'sale_items', 'sale_returns', 'sale_return_items', 'stock_adjustments',
    'stock_adjustment_items', 'stock_transfers', 'stock_transfer_items',
    'payments', 'customer_ledger', 'supplier_ledger', 'expense_categories',
    'expenses', 'daily_summaries', 'document_counters', 'idempotency_keys',
    'outbox_events', 'ai_intake_sessions', 'ai_intake_items'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())',
      t
    );
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (
    id = app_tenant_id()
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.tenant_id = tenants.id AND m.user_id = app_user_id()
    )
  )
  WITH CHECK (id = app_tenant_id());

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_visibility ON memberships
  USING (tenant_id = app_tenant_id() OR user_id = app_user_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_tenant ON audit_logs
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY session_owner ON sessions
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

GRANT USAGE ON SCHEMA public TO dukaan_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dukaan_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dukaan_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO dukaan_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dukaan_app;

COMMENT ON TABLE inventory_movements IS
  'Append-only stock ledger. On-hand quantity is the sum of quantity_delta.';
COMMENT ON TABLE inventory_balances IS
  'Cached on-hand quantity and per-location weighted average cost. Rebuildable from inventory_movements.';
COMMENT ON TABLE daily_summaries IS
  'Derived reporting cache for one shop and one business date. Not a source of truth.';
COMMENT ON TABLE ai_intake_sessions IS
  'AI product intake draft. Confirming stock happens only by creating a normal purchase or opening adjustment.';
COMMENT ON TABLE ai_intake_items IS
  'Suggested intake lines. No foreign key to inventory_movements or inventory_balances.';
COMMENT ON COLUMN sale_items.unit_cost IS
  'Cost snapshot at sale time. Profit must use this value, never the current average cost.';
COMMENT ON COLUMN purchase_items.unit_cost IS
  'Purchase cost captured on the bill. Later catalog price edits do not change this line.';
COMMENT ON COLUMN customer_ledger.debit_amount IS
  'Increases what the customer owes the shop.';
COMMENT ON COLUMN customer_ledger.credit_amount IS
  'Decreases what the customer owes the shop.';
COMMENT ON COLUMN supplier_ledger.credit_amount IS
  'Increases what the shop owes the supplier.';
COMMENT ON COLUMN supplier_ledger.debit_amount IS
  'Decreases what the shop owes the supplier.';
COMMENT ON FUNCTION next_document_number(uuid, document_type) IS
  'Allocates the next bill number under a row lock. Call it in the same transaction as the document insert.';

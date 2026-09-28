-- Read-only checks. A non-zero count is a failed invariant.
SELECT 'negative_stock' AS check_name, count(*) AS failures
FROM inventory_balances
WHERE quantity < 0
UNION ALL
SELECT 'balance_movement_mismatch', count(*)
FROM (
  SELECT b.tenant_id, b.product_id, b.location_id
  FROM inventory_balances b
  LEFT JOIN inventory_movements m
    ON m.tenant_id = b.tenant_id
   AND m.product_id = b.product_id
   AND m.location_id = b.location_id
  GROUP BY b.tenant_id, b.product_id, b.location_id, b.quantity
  HAVING b.quantity <> COALESCE(SUM(m.quantity_delta), 0)
) mismatches;

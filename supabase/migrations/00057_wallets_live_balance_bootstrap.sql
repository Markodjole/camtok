-- Align live betting balance with persisted user wallet ($1000 welcome for unfunded rows;
-- copy main → demo when demo was never set but main balance exists).

UPDATE public.wallets
SET balance_demo = balance
WHERE balance_demo IS DISTINCT FROM balance
  AND balance > 0
  AND balance_demo = 0;

UPDATE public.wallets
SET
  balance = 1000.00,
  balance_demo = 1000.00,
  total_deposited = GREATEST(total_deposited, 1000.00)
WHERE balance <= 0
  AND balance_demo <= 0
  AND COALESCE(total_deposited, 0) <= 0;

-- One-time bulk top-up: every auth user gets a wallet row at 100_000.00
-- with a matching admin_adjustment ledger line (dev / QA convenience).

INSERT INTO public.wallets (user_id, balance, total_deposited, total_withdrawn, total_won, total_lost)
SELECT u.id,
       0::numeric(12, 2),
       0::numeric(12, 2),
       0::numeric(12, 2),
       0::numeric(12, 2),
       0::numeric(12, 2)
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.wallets w WHERE w.user_id = u.id);

WITH adjusted AS (
  SELECT
    w.id AS wallet_id,
    w.balance AS old_balance,
    (100000::numeric(12, 2) - w.balance) AS delta
  FROM public.wallets w
  WHERE w.balance IS DISTINCT FROM 100000::numeric(12, 2)
)
INSERT INTO public.wallet_transactions (wallet_id, type, amount, balance_after, description)
SELECT
  wallet_id,
  'admin_adjustment'::public.wallet_tx_type,
  delta,
  100000::numeric(12, 2),
  'Bulk top-up: set balance to 100000'
FROM adjusted
WHERE delta IS DISTINCT FROM 0::numeric(12, 2);

UPDATE public.wallets
SET balance = 100000::numeric(12, 2)
WHERE balance IS DISTINCT FROM 100000::numeric(12, 2);

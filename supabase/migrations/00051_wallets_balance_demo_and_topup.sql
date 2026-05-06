-- Live betting (`placeLiveBet`) debits `wallets.balance_demo`. Previous top-ups only
-- touched `balance`, so demo bets saw "Insufficient balance" while the wallet UI looked funded.
-- Adds the column if missing, syncs/top-ups both columns for QA.

ALTER TABLE public.wallets
  ADD COLUMN IF NOT EXISTS balance_demo NUMERIC(12, 2) NOT NULL DEFAULT 0;

-- Match demo lane to ledger balance where demo was never set
UPDATE public.wallets
SET balance_demo = balance
WHERE balance_demo IS DISTINCT FROM balance;

-- Generous testing balance (cap for NUMERIC(12,2))
WITH adjusted AS (
  SELECT
    w.id AS wallet_id,
    w.balance AS old_balance,
    (9999999.99::numeric(12, 2) - w.balance) AS delta
  FROM public.wallets w
  WHERE w.balance IS DISTINCT FROM 9999999.99::numeric(12, 2)
)
INSERT INTO public.wallet_transactions (wallet_id, type, amount, balance_after, description)
SELECT
  wallet_id,
  'admin_adjustment'::public.wallet_tx_type,
  delta,
  9999999.99::numeric(12, 2),
  'Demo top-up: balance + balance_demo for live betting QA'
FROM adjusted
WHERE delta IS DISTINCT FROM 0::numeric(12, 2);

UPDATE public.wallets
SET
  balance = 9999999.99::numeric(12, 2),
  balance_demo = 9999999.99::numeric(12, 2)
WHERE balance IS DISTINCT FROM 9999999.99::numeric(12, 2)
   OR balance_demo IS DISTINCT FROM 9999999.99::numeric(12, 2);

-- New signups: keep `balance` / `balance_demo` aligned (trigger welcome amount).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  safe_username TEXT;
  safe_display_name TEXT;
  suffix TEXT;
BEGIN
  safe_username := TRIM(COALESCE(NEW.raw_user_meta_data->>'username', ''));
  IF char_length(safe_username) < 3 OR char_length(safe_username) > 30 THEN
    safe_username := 'user_' || REPLACE(SUBSTR(NEW.id::text, 1, 8), '-', '');
  END IF;
  safe_username := SUBSTRING(safe_username FROM 1 FOR 30);

  safe_display_name := TRIM(COALESCE(NEW.raw_user_meta_data->>'display_name', ''));
  IF char_length(safe_display_name) < 1 THEN
    safe_display_name := COALESCE(NULLIF(safe_username, ''), 'User');
  END IF;
  safe_display_name := SUBSTRING(safe_display_name FROM 1 FOR 60);

  suffix := REPLACE(SUBSTR(NEW.id::text, 1, 6), '-', '');
  IF EXISTS (SELECT 1 FROM public.profiles WHERE username = safe_username) THEN
    safe_username := SUBSTRING(safe_username FROM 1 FOR 23) || '_' || suffix;
  END IF;

  INSERT INTO public.profiles (id, username, display_name)
  VALUES (NEW.id, safe_username, safe_display_name);

  INSERT INTO public.wallets (user_id, balance, balance_demo, total_deposited)
  VALUES (NEW.id, 1000.00, 1000.00, 1000.00);

  INSERT INTO public.wallet_transactions (wallet_id, type, amount, balance_after, description)
  SELECT w.id, 'deposit_demo'::wallet_tx_type, 1000.00, 1000.00, 'Welcome bonus'
  FROM public.wallets w WHERE w.user_id = NEW.id;

  RETURN NEW;
END;
$$;

-- Durable idempotency for AI credit reservations.
-- Apply this migration before deploying the Worker version that calls
-- consume_ai_credit_idempotent. This file is prepared locally and is not applied.
-- This migration is versioned for reproducible schema rollout; deployment does not run it automatically.

ALTER TABLE public.ai_usage_logs
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_logs_user_idempotency_key_uidx
  ON public.ai_usage_logs (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.consume_ai_credit_idempotent(
  p_user_id uuid,
  p_action text,
  p_model text,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_balance integer;
  v_log_id bigint;
  v_status text;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  IF p_user_id IS NULL OR p_idempotency_key IS NULL OR coalesce(btrim(p_action), '') = '' THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  -- Fast path for a previously committed request.
  SELECT l.id, l.status, c.balance
    INTO v_log_id, v_status, v_balance
    FROM public.ai_usage_logs AS l
    LEFT JOIN public.ai_credits AS c ON c.user_id = l.user_id
   WHERE l.user_id = p_user_id
     AND l.idempotency_key = p_idempotency_key
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'reservation_id', v_log_id,
      'credits_remaining', v_balance,
      'duplicate', true,
      'status', v_status
    );
  END IF;

  -- The unique index arbitrates concurrent identical keys. If another
  -- transaction wins, this subtransaction rolls back its balance decrement.
  BEGIN
    UPDATE public.ai_credits
       SET balance = balance - 1,
           updated_at = now()
     WHERE user_id = p_user_id
       AND balance > 0
     RETURNING balance INTO v_balance;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INSUFFICIENT_CREDITS';
    END IF;

    INSERT INTO public.ai_usage_logs (
      user_id, action, model, credits_used, status, metadata, idempotency_key
    ) VALUES (
      p_user_id, p_action, p_model, 1, 'reserved', '{}'::jsonb, p_idempotency_key
    )
    RETURNING id INTO v_log_id;

    RETURN jsonb_build_object(
      'reservation_id', v_log_id,
      'credits_remaining', v_balance,
      'duplicate', false,
      'status', 'reserved'
    );
  EXCEPTION WHEN unique_violation THEN
    SELECT l.id, l.status, c.balance
      INTO v_log_id, v_status, v_balance
      FROM public.ai_usage_logs AS l
      LEFT JOIN public.ai_credits AS c ON c.user_id = l.user_id
     WHERE l.user_id = p_user_id
       AND l.idempotency_key = p_idempotency_key
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE;
    END IF;
    RETURN jsonb_build_object(
      'reservation_id', v_log_id,
      'credits_remaining', v_balance,
      'duplicate', true,
      'status', v_status
    );
  END;
END;
$function$;

-- Fail closed on the old non-idempotent path. The replacement Worker uses the
-- new RPC; the legacy call must not remain a way to reserve without a key.
REVOKE ALL ON FUNCTION public.consume_ai_credit(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.consume_ai_credit_idempotent(uuid, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_ai_credit_idempotent(uuid, text, text, uuid)
  TO service_role;

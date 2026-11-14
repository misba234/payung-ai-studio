-- Add Gemini as a separately capped provider without changing the active provider.
-- Each provider has its own cumulative 500000-token Payung cap; neither cap auto-resets.
-- Gemini 429/rate-limit responses hard-stop that route for at least 24 hours.
-- No provider key, prompt, provider balance, or paid fallback is stored or changed here.

ALTER TABLE public.ai_provider_token_budget
  DROP CONSTRAINT IF EXISTS ai_provider_token_budget_provider_check;
ALTER TABLE public.ai_provider_token_budget
  ADD CONSTRAINT ai_provider_token_budget_provider_check
  CHECK (provider IN ('codecraft', 'gemini'));

INSERT INTO public.ai_provider_token_budget (provider, token_limit, used_tokens, reserved_tokens)
VALUES ('gemini', 500000, 0, 0)
ON CONFLICT (provider) DO NOTHING;

COMMENT ON TABLE public.ai_provider_token_budget IS
  'Server-only cumulative 500000-token Payung cap per explicitly configured AI provider; caps do not auto-reset.';
COMMENT ON TABLE public.ai_provider_token_reservations IS
  'Server-only idempotent per-request token reservations backing each provider-specific Payung 500000-token cap.';

CREATE OR REPLACE FUNCTION public.reserve_ai_provider_tokens(
  p_provider text,
  p_user_id uuid,
  p_idempotency_key uuid,
  p_requested_tokens bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_limit bigint;
  v_used bigint;
  v_reserved bigint;
  v_blocked_at timestamptz;
  v_blocked_reason text;
  v_existing_id bigint;
  v_existing_status text;
  v_remaining bigint;
  v_reservation_id bigint;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  IF p_provider IS NULL
     OR p_provider NOT IN ('codecraft', 'gemini')
     OR p_user_id IS NULL
     OR p_idempotency_key IS NULL
     OR p_requested_tokens IS NULL
     OR p_requested_tokens <= 0
     OR p_requested_tokens > 500000 THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  -- Serialize reservations per provider so concurrent public requests cannot oversubscribe.
  SELECT b.token_limit, b.used_tokens, b.reserved_tokens, b.blocked_at, b.blocked_reason
    INTO v_limit, v_used, v_reserved, v_blocked_at, v_blocked_reason
    FROM public.ai_provider_token_budget AS b
   WHERE b.provider = p_provider
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TOKEN_BUDGET_NOT_CONFIGURED';
  END IF;

  SELECT r.id, r.status
    INTO v_existing_id, v_existing_status
    FROM public.ai_provider_token_reservations AS r
   WHERE r.provider = p_provider
     AND r.user_id = p_user_id
     AND r.idempotency_key = p_idempotency_key
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'duplicate', true,
      'reservation_id', v_existing_id,
      'status', v_existing_status,
      'token_limit', v_limit,
      'used_tokens', v_used,
      'reserved_tokens', v_reserved,
      'remaining_tokens', greatest(v_limit - v_used - v_reserved, 0),
      'blocked', v_blocked_at IS NOT NULL,
      'blocked_reason', v_blocked_reason
    );
  END IF;

  -- A Gemini rate-limit response pauses that provider for 24 hours, then permits
  -- a fresh attempt. The cumulative token cap is never reset by this cooldown.
  IF p_provider = 'gemini'
     AND v_blocked_at IS NOT NULL
     AND v_blocked_reason = 'provider_rate_limited'
     AND v_blocked_at <= now() - interval '24 hours' THEN
    UPDATE public.ai_provider_token_budget
       SET blocked_at = NULL,
           blocked_reason = NULL,
           updated_at = now()
     WHERE provider = p_provider;
    v_blocked_at := NULL;
    v_blocked_reason := NULL;
  END IF;

  v_remaining := greatest(v_limit - v_used - v_reserved, 0);
  IF v_blocked_at IS NOT NULL OR p_requested_tokens > v_remaining THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'duplicate', false,
      'token_limit', v_limit,
      'used_tokens', v_used,
      'reserved_tokens', v_reserved,
      'remaining_tokens', v_remaining,
      'blocked', v_blocked_at IS NOT NULL,
      'blocked_reason', v_blocked_reason
    );
  END IF;

  INSERT INTO public.ai_provider_token_reservations (
    provider, user_id, idempotency_key, reserved_tokens, status
  ) VALUES (
    p_provider, p_user_id, p_idempotency_key, p_requested_tokens, 'reserved'
  ) RETURNING id INTO v_reservation_id;

  UPDATE public.ai_provider_token_budget
     SET reserved_tokens = reserved_tokens + p_requested_tokens,
         updated_at = now()
   WHERE provider = p_provider
   RETURNING token_limit, used_tokens, reserved_tokens
        INTO v_limit, v_used, v_reserved;

  RETURN jsonb_build_object(
    'allowed', true,
    'duplicate', false,
    'reservation_id', v_reservation_id,
    'status', 'reserved',
    'token_limit', v_limit,
    'used_tokens', v_used,
    'reserved_tokens', v_reserved,
    'remaining_tokens', greatest(v_limit - v_used - v_reserved, 0),
    'blocked', false,
    'blocked_reason', NULL
  );
END;
$function$;

-- Acquire locks in the same order as reserve (budget row, then reservation row)
-- to avoid the lock-order deadlock in the earlier settlement definition.
CREATE OR REPLACE FUNCTION public.settle_ai_provider_tokens(
  p_reservation_id bigint,
  p_actual_tokens bigint,
  p_usage_known boolean,
  p_force_block boolean,
  p_block_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_provider text;
  v_reserved_for_request bigint;
  v_status text;
  v_limit bigint;
  v_used bigint;
  v_reserved_total bigint;
  v_blocked_at timestamptz;
  v_blocked_reason text;
  v_accounted bigint;
  v_new_used bigint;
  v_new_reserved bigint;
  v_overrun boolean;
  v_should_block boolean;
  v_new_status text;
  v_new_reason text;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  IF p_reservation_id IS NULL OR p_reservation_id <= 0 OR p_usage_known IS NULL OR p_force_block IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  IF p_force_block AND coalesce(p_block_reason, '') NOT IN (
    'provider_quota_or_balance_exhausted', 'provider_rate_limited'
  ) THEN
    RAISE EXCEPTION 'INVALID_BLOCK_REASON';
  END IF;

  -- Read the immutable provider id first, then take locks in budget-before-reservation order.
  SELECT r.provider
    INTO v_provider
    FROM public.ai_provider_token_reservations AS r
   WHERE r.id = p_reservation_id
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TOKEN_RESERVATION_NOT_FOUND';
  END IF;

  SELECT b.token_limit, b.used_tokens, b.reserved_tokens, b.blocked_at, b.blocked_reason
    INTO v_limit, v_used, v_reserved_total, v_blocked_at, v_blocked_reason
    FROM public.ai_provider_token_budget AS b
   WHERE b.provider = v_provider
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TOKEN_BUDGET_NOT_CONFIGURED';
  END IF;

  SELECT r.reserved_tokens, r.status
    INTO v_reserved_for_request, v_status
    FROM public.ai_provider_token_reservations AS r
   WHERE r.id = p_reservation_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TOKEN_RESERVATION_NOT_FOUND';
  END IF;

  IF v_status <> 'reserved' THEN
    RETURN jsonb_build_object(
      'settled', false,
      'duplicate', true,
      'status', v_status,
      'provider', v_provider,
      'token_limit', v_limit,
      'used_tokens', v_used,
      'reserved_tokens', v_reserved_total,
      'remaining_tokens', greatest(v_limit - v_used - v_reserved_total, 0),
      'blocked', v_blocked_at IS NOT NULL,
      'blocked_reason', v_blocked_reason
    );
  END IF;

  IF p_usage_known AND p_actual_tokens IS NOT NULL AND p_actual_tokens >= 0 THEN
    v_accounted := p_actual_tokens;
  ELSE
    -- If the provider may have received the request but did not report usage,
    -- consume the whole reservation rather than risk undercounting.
    v_accounted := v_reserved_for_request;
  END IF;
  v_overrun := v_accounted > v_reserved_for_request;
  v_new_status := CASE
    WHEN v_overrun THEN 'blocked_overrun'
    WHEN p_usage_known AND p_actual_tokens IS NOT NULL AND p_actual_tokens >= 0 THEN 'settled'
    ELSE 'settled_worst_case'
  END;
  v_new_used := v_used + v_accounted;
  v_new_reserved := greatest(v_reserved_total - v_reserved_for_request, 0);
  v_should_block := p_force_block OR v_overrun OR v_new_used >= v_limit;
  v_new_reason := CASE
    WHEN v_blocked_reason IN ('reservation_overrun', 'token_cap_reached', 'provider_quota_or_balance_exhausted') THEN v_blocked_reason
    WHEN p_force_block THEN p_block_reason
    WHEN v_overrun THEN 'reservation_overrun'
    WHEN v_new_used >= v_limit THEN 'token_cap_reached'
    ELSE v_blocked_reason
  END;

  UPDATE public.ai_provider_token_budget
     SET used_tokens = v_new_used,
         reserved_tokens = v_new_reserved,
         blocked_at = CASE WHEN v_should_block THEN coalesce(blocked_at, now()) ELSE blocked_at END,
         blocked_reason = CASE WHEN v_should_block THEN v_new_reason ELSE blocked_reason END,
         updated_at = now()
   WHERE provider = v_provider;

  UPDATE public.ai_provider_token_reservations
     SET provider_reported_tokens = CASE
           WHEN p_usage_known AND p_actual_tokens IS NOT NULL AND p_actual_tokens >= 0 THEN p_actual_tokens
           ELSE NULL
         END,
         accounted_tokens = v_accounted,
         status = v_new_status,
         settled_at = now()
   WHERE id = p_reservation_id;

  RETURN jsonb_build_object(
    'settled', true,
    'duplicate', false,
    'status', v_new_status,
    'provider', v_provider,
    'accounted_tokens', v_accounted,
    'overrun', v_overrun,
    'token_limit', v_limit,
    'used_tokens', v_new_used,
    'reserved_tokens', v_new_reserved,
    'remaining_tokens', greatest(v_limit - v_new_used - v_new_reserved, 0),
    'blocked', v_should_block OR v_blocked_at IS NOT NULL,
    'blocked_reason', CASE WHEN v_should_block THEN v_new_reason ELSE v_blocked_reason END
  );
END;
$function$;

-- Independent, idempotent hard-stop path used if settlement cannot confirm a 429/quota block.
CREATE OR REPLACE FUNCTION public.block_ai_provider_tokens(
  p_provider text,
  p_block_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_blocked_at timestamptz;
  v_blocked_reason text;
  v_new_reason text;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  IF p_provider IS NULL
     OR p_provider NOT IN ('codecraft', 'gemini')
     OR coalesce(p_block_reason, '') NOT IN ('provider_quota_or_balance_exhausted', 'provider_rate_limited') THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  SELECT b.blocked_at, b.blocked_reason
    INTO v_blocked_at, v_blocked_reason
    FROM public.ai_provider_token_budget AS b
   WHERE b.provider = p_provider
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TOKEN_BUDGET_NOT_CONFIGURED';
  END IF;

  v_new_reason := CASE
    WHEN v_blocked_reason IN ('reservation_overrun', 'token_cap_reached', 'provider_quota_or_balance_exhausted') THEN v_blocked_reason
    WHEN p_block_reason = 'provider_quota_or_balance_exhausted' THEN p_block_reason
    ELSE p_block_reason
  END;

  UPDATE public.ai_provider_token_budget
     SET blocked_at = coalesce(blocked_at, now()),
         blocked_reason = v_new_reason,
         updated_at = now()
   WHERE provider = p_provider
   RETURNING blocked_at, blocked_reason INTO v_blocked_at, v_blocked_reason;

  RETURN jsonb_build_object(
    'blocked', v_blocked_at IS NOT NULL,
    'blocked_reason', v_blocked_reason,
    'provider', p_provider
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_ai_provider_tokens(text, uuid, uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.settle_ai_provider_tokens(bigint, bigint, boolean, boolean, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.block_ai_provider_tokens(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_ai_provider_tokens(text, uuid, uuid, bigint)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_ai_provider_tokens(bigint, bigint, boolean, boolean, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.block_ai_provider_tokens(text, text)
  TO service_role;

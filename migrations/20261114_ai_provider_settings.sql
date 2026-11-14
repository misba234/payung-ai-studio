-- Private server-side provider/model selection for Payung AI Studio.
-- This local migration is not applied automatically. Review and apply it before deploying the matching Worker.
-- Provider API keys are never stored in this table; they belong only in Cloudflare Worker Secrets.

CREATE TABLE IF NOT EXISTS public.ai_provider_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  active_provider text NOT NULL DEFAULT 'codecraft'
    CHECK (active_provider ~ '^[a-z][a-z0-9_-]{0,63}$'),
  model_id text NOT NULL DEFAULT 'deepseek-v4-flash-0731'
    CHECK (char_length(model_id) <= 128),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.ai_provider_settings IS
  'Private provider/model selection read and written by the Payung AI Studio Worker using service_role; never store provider API keys here.';

ALTER TABLE public.ai_provider_settings ENABLE ROW LEVEL SECURITY;

-- Browser clients cannot inspect or modify global provider settings. The Worker
-- authenticates the configured admin and accesses this table with service_role.
REVOKE ALL ON TABLE public.ai_provider_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON TABLE public.ai_provider_settings TO service_role;

INSERT INTO public.ai_provider_settings (id, active_provider, model_id)
VALUES (1, 'codecraft', 'deepseek-v4-flash-0731')
ON CONFLICT (id) DO NOTHING;

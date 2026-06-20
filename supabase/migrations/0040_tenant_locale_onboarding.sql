-- 0040_tenant_locale_onboarding.sql
-- Guided onboarding for new SaaS tenants: instead of typing /apikey and /groqkey
-- commands, a new user is walked through a short wizard (language -> name ->
-- Anthropic key -> Groq key). We track where they are with onboarding_step and
-- remember their chosen interface/reply language in locale. Idempotent.

alter table tenants add column if not exists locale text not null default 'ru'
  check (locale in ('uk', 'ru', 'pl', 'en'));

-- Wizard position: 'lang' | 'name' | 'apikey' | 'groqkey'; NULL once finished.
alter table tenants add column if not exists onboarding_step text;

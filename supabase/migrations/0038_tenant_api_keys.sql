-- 0038_tenant_api_keys.sql
-- Per-tenant API keys so SaaS testers pay for their own AI usage. When set, the
-- tenant's Anthropic/Groq key is used for all AI calls in that workspace; the
-- family tenant leaves these NULL and keeps using the owner's env keys.
--
-- NOTE: stored as plaintext for the MVP. The DB is reachable only via the
-- service role, but encrypting these at rest (pgcrypto / app-side) is a tracked
-- hardening follow-up before wider rollout.

alter table tenants add column if not exists anthropic_api_key text;
alter table tenants add column if not exists groq_api_key text;

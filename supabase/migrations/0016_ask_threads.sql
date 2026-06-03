-- /ask conversational thread state.
-- When the bot answers a /ask question (or a follow-up), we record the bot's
-- reply message_id together with the full conversation so far. When the user
-- replies to that bubble, the webhook looks up the thread by bot_message_id
-- and re-runs the analyst with the prior turns as context. Without this the
-- follow-up "Как считал?" hits the expense parser and ends up as a 0.01 PLN
-- "transaction" - which is exactly what the user complained about.

create table if not exists ask_threads (
  id uuid primary key default uuid_generate_v4(),
  chat_id bigint not null,
  bot_message_id bigint not null,
  family_member_id uuid not null references family_members(id),
  -- History as ordered [{question, answer}, ...] pairs. Latest pair last.
  history jsonb not null default '[]'::jsonb,
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  unique (chat_id, bot_message_id)
);

create index if not exists ask_threads_lookup_idx
  on ask_threads (chat_id, bot_message_id);
create index if not exists ask_threads_expires_idx on ask_threads (expires_at);

alter table ask_threads disable row level security;

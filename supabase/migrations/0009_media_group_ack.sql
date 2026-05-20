-- 0009_media_group_ack.sql
-- Add ack_message_id + chat_id to media_group_buffer so cron-media-group-sweep
-- can edit the original "Принимаю альбом, секунду..." bubble with progress
-- updates and final outcome.

alter table media_group_buffer
  add column if not exists ack_message_id bigint,
  add column if not exists chat_id bigint;

-- Conductor channel bindings — record the channel SCOPE (Teams: tenant id, Slack: workspace/team id)
-- a binding was captured in. Bindings are keyed (user_id, channel_type); with several Teams bots in
-- different tenants the same email could bind through either tenant, and a people-directory
-- suggestion from one tenant would route via whatever binding was written last. The scope is
-- captured ADDITIVELY here (nullable, no key change) so a scope-aware resolver can be built on
-- real data; until then behaviour is unchanged (latest binding per user+channel wins).
-- Forward-only, idempotent.
ALTER TABLE conductor_channel_bindings ADD COLUMN IF NOT EXISTS channel_scope TEXT;

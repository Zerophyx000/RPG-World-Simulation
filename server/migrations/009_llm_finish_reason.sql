-- step A6: why a call ended (stop | length | tool_calls | content_filter): cut-off retries and
-- usage() cutoff rates read it. Old rows just have NULL, like any other value we don't know.
ALTER TABLE llm_calls ADD COLUMN finish_reason TEXT;

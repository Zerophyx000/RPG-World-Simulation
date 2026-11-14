// Step 10 (0.1): why each decide call ran at its tier (waking, new_stimulus, emotion_jump, death_news, altercation,
// tier_capped, conversation, ordinary, routine, governor, retry_cutoff, retry_invalid). The column is added only when
// it isn't there yet; old rows keep NULL.
export function up(db) {
  const cols = db.prepare('PRAGMA table_info(llm_calls)').all().map((c) => c.name);
  if (!cols.includes('tier_reason')) db.exec('ALTER TABLE llm_calls ADD COLUMN tier_reason TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_llm_calls_purpose_time ON llm_calls (purpose, real_time)');
}

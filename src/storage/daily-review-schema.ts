import type { Database } from "bun:sqlite";

/** Additive metadata only. Execution and native uncertainty stay in the existing run journal. */
export function migrateDailyReview(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS daily_review_batches (
    review_date TEXT PRIMARY KEY NOT NULL CHECK(length(review_date)=10),
    admitted_at TEXT NOT NULL,
    eligible_count INTEGER NOT NULL CHECK(eligible_count>0),
    ceiling INTEGER NOT NULL CHECK(ceiling>0 AND ceiling<=eligible_count),
    admitted_count INTEGER NOT NULL CHECK(admitted_count>0 AND admitted_count<=ceiling),
    policy_json TEXT NOT NULL CHECK(json_valid(policy_json) AND json_type(policy_json)='object')
  );
  CREATE TABLE IF NOT EXISTS daily_review_items (
    run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED,
    review_date TEXT NOT NULL REFERENCES daily_review_batches(review_date),
    thought_id TEXT NOT NULL REFERENCES thoughts(id),
    position INTEGER NOT NULL CHECK(position>=0),
    completed_at TEXT,
    UNIQUE(review_date,thought_id), UNIQUE(review_date,position)
  );
  CREATE INDEX IF NOT EXISTS daily_review_subject_history ON daily_review_items(thought_id,completed_at);
  CREATE INDEX IF NOT EXISTS daily_review_creator_input ON runs(input_thought_id) WHERE input_thought_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS daily_review_creator_issued ON run_issued_thoughts(thought_id,run_id);
  CREATE TRIGGER IF NOT EXISTS daily_review_batches_update BEFORE UPDATE ON daily_review_batches
  BEGIN SELECT RAISE(ABORT,'review batch immutable'); END;
  CREATE TRIGGER IF NOT EXISTS daily_review_batches_delete BEFORE DELETE ON daily_review_batches
  BEGIN SELECT RAISE(ABORT,'review batch immutable'); END;
  CREATE TRIGGER IF NOT EXISTS daily_review_items_insert BEFORE INSERT ON daily_review_items
  WHEN NEW.completed_at IS NOT NULL OR EXISTS(SELECT 1 FROM daily_review_items WHERE run_id=NEW.run_id)
    OR NOT EXISTS(SELECT 1 FROM daily_review_batches b JOIN thoughts t ON t.id=NEW.thought_id
      WHERE b.review_date=NEW.review_date AND t.kind!='media-original'
        AND NOT EXISTS(SELECT 1 FROM rejected_thoughts r WHERE r.thought_id=t.id)
        AND NEW.position=COALESCE((SELECT max(position)+1 FROM daily_review_items WHERE review_date=b.review_date),0)
        AND NEW.position<b.admitted_count)
  BEGIN SELECT RAISE(ABORT,'invalid review membership'); END;
  CREATE TRIGGER IF NOT EXISTS daily_review_items_update BEFORE UPDATE ON daily_review_items
  WHEN NEW.run_id IS NOT OLD.run_id OR NEW.review_date IS NOT OLD.review_date OR NEW.thought_id IS NOT OLD.thought_id
    OR NEW.position IS NOT OLD.position OR OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL
    OR NOT EXISTS(SELECT 1 FROM runs r JOIN run_steps s ON s.run_id=r.id
      WHERE r.id=OLD.run_id AND r.status='completed' AND r.kind='weave' AND r.weave_subject_id=OLD.thought_id
        AND r.weave_trigger_id='daily-review:'||OLD.review_date AND s.position=(SELECT max(position) FROM run_steps WHERE run_id=r.id)
        AND s.state='completed' AND json_extract(s.envelope_json,'$.kind')='review-complete'
        AND json_extract(s.envelope_json,'$.titleCheck')='complete' AND json_extract(s.envelope_json,'$.connectionCheck')='complete')
    OR EXISTS(SELECT 1 FROM restore_fences f WHERE f.entity_kind='run' AND f.entity_id=OLD.run_id)
  BEGIN SELECT RAISE(ABORT,'review completion immutable or unconfirmed'); END;
  CREATE TRIGGER IF NOT EXISTS daily_review_items_delete BEFORE DELETE ON daily_review_items
  BEGIN SELECT RAISE(ABORT,'review membership immutable'); END;
  CREATE TRIGGER IF NOT EXISTS daily_review_run_membership BEFORE INSERT ON runs
  WHEN NEW.kind='weave' AND (substr(NEW.weave_trigger_id,1,13)='daily-review:' OR NEW.weave_trigger_id='daily-review') AND NOT EXISTS(
    SELECT 1 FROM daily_review_items i WHERE i.run_id=NEW.id AND i.thought_id=NEW.weave_subject_id
      AND NEW.weave_trigger_id='daily-review:'||i.review_date)
  BEGIN SELECT RAISE(ABORT,'daily review requires owned membership'); END;`);
}

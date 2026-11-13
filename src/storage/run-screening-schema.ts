import type { Database } from "bun:sqlite";

/** Additive, inside the core migration transaction after predecessor FK rebuilds. Never infer old judgments. */
export function migrateRunScreening(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS run_screening_passes (
    run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id),
    subject_id TEXT NOT NULL REFERENCES thoughts(id),
    policy_json TEXT NOT NULL CHECK(json_valid(policy_json) AND json_type(policy_json)='object'),
    candidate_count INTEGER NOT NULL CHECK(candidate_count>=0),
    status TEXT NOT NULL CHECK(status IN ('collecting','complete','fallback')),
    failure_code TEXT CHECK(failure_code IN ('screening-unavailable','eligibility-changed','configuration-changed')),
    CHECK((status='fallback')=(failure_code IS NOT NULL))
  );
  CREATE TABLE IF NOT EXISTS run_screening_pairs (
    run_id TEXT NOT NULL REFERENCES run_screening_passes(run_id),
    candidate_id TEXT NOT NULL REFERENCES thoughts(id),
    position INTEGER NOT NULL CHECK(position>=0),
    judgment_json TEXT CHECK(judgment_json IS NULL OR (json_valid(judgment_json) AND json_type(judgment_json)='object'
      AND json_type(judgment_json,'$.score') IN ('integer','real') AND json_extract(judgment_json,'$.score') BETWEEN 0 AND 1)),
    PRIMARY KEY(run_id,candidate_id), UNIQUE(run_id,position)
  );
  CREATE TRIGGER IF NOT EXISTS screening_pass_insert BEFORE INSERT ON run_screening_passes
  WHEN EXISTS(SELECT 1 FROM run_screening_passes WHERE run_id=NEW.run_id) OR NEW.status!='collecting'
    OR NOT EXISTS(SELECT 1 FROM runs r JOIN thoughts t ON t.id=NEW.subject_id JOIN run_steps s ON s.run_id=r.id AND s.position=0
      WHERE r.id=NEW.run_id AND r.kind='weave' AND r.weave_subject_id=NEW.subject_id AND t.kind!='media-original'
        AND r.status='queued' AND r.weave_retired_at IS NULL AND s.input IS NULL)
  BEGIN SELECT RAISE(ABORT,'invalid screening owner'); END;
  CREATE TRIGGER IF NOT EXISTS screening_pass_update BEFORE UPDATE ON run_screening_passes
  WHEN NEW.run_id IS NOT OLD.run_id OR NEW.subject_id IS NOT OLD.subject_id OR NEW.policy_json IS NOT OLD.policy_json
    OR NEW.candidate_count IS NOT OLD.candidate_count OR OLD.status!='collecting' OR NEW.status='collecting'
    OR (NEW.status='complete' AND ((SELECT count(*) FROM run_screening_pairs WHERE run_id=OLD.run_id)!=OLD.candidate_count
      OR EXISTS(SELECT 1 FROM run_screening_pairs WHERE run_id=OLD.run_id AND judgment_json IS NULL)))
  BEGIN SELECT RAISE(ABORT,'screening identity or completion immutable'); END;
  CREATE TRIGGER IF NOT EXISTS screening_pass_delete BEFORE DELETE ON run_screening_passes
  BEGIN SELECT RAISE(ABORT,'screening history immutable'); END;
  CREATE TRIGGER IF NOT EXISTS screening_pair_insert BEFORE INSERT ON run_screening_pairs
  WHEN EXISTS(SELECT 1 FROM run_screening_pairs WHERE run_id=NEW.run_id AND candidate_id=NEW.candidate_id)
    OR NEW.judgment_json IS NOT NULL OR NOT EXISTS(SELECT 1 FROM run_screening_passes p JOIN thoughts t ON t.id=NEW.candidate_id
      WHERE p.run_id=NEW.run_id AND p.status='collecting' AND t.kind!='media-original' AND p.subject_id!=NEW.candidate_id
        AND NEW.position=COALESCE((SELECT max(position)+1 FROM run_screening_pairs WHERE run_id=p.run_id),0) AND NEW.position<p.candidate_count)
  BEGIN SELECT RAISE(ABORT,'invalid screening membership'); END;
  CREATE TRIGGER IF NOT EXISTS screening_pair_update BEFORE UPDATE ON run_screening_pairs
  WHEN NEW.run_id IS NOT OLD.run_id OR NEW.candidate_id IS NOT OLD.candidate_id OR NEW.position IS NOT OLD.position
    OR OLD.judgment_json IS NOT NULL OR NEW.judgment_json IS NULL
    OR NOT EXISTS(SELECT 1 FROM run_screening_passes WHERE run_id=OLD.run_id AND status='collecting')
  BEGIN SELECT RAISE(ABORT,'screening judgment immutable'); END;
  CREATE TRIGGER IF NOT EXISTS screening_pair_delete BEFORE DELETE ON run_screening_pairs
  BEGIN SELECT RAISE(ABORT,'screening membership immutable'); END;`);
}

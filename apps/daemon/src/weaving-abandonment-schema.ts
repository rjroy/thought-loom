import type { Database } from "bun:sqlite";

export function migrateWeavingAbandonment(db: Database): void {
  db.run(`CREATE TABLE weaving_abandonments (
    id TEXT PRIMARY KEY NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id), run_id TEXT NOT NULL UNIQUE REFERENCES weaving_runs(id),
    session_id TEXT NOT NULL, prompt_id TEXT NOT NULL, created_at INTEGER NOT NULL CHECK(created_at>=0),
    acknowledgement TEXT NOT NULL CHECK(acknowledgement='native-may-continue-and-charge')
  )`);
  db.run(`CREATE TRIGGER weaving_abandonment_scope BEFORE INSERT ON weaving_abandonments WHEN NOT EXISTS (
    SELECT 1 FROM weaving_runs r JOIN jobs j ON j.id=r.job_id WHERE j.id=NEW.job_id AND r.id=NEW.run_id
      AND r.session_id=NEW.session_id AND r.prompt_id=NEW.prompt_id AND j.status='uncertain'
      AND j.kind IN ('capture','dialogue','follow_up') AND r.state='uncertain' AND r.outcome IS NULL
      AND r.lease_owner IS NULL AND r.lease_until IS NULL
      AND NOT EXISTS (SELECT 1 FROM weaving_runs later WHERE later.job_id=j.id AND later.attempt>r.attempt)
      AND NOT EXISTS (SELECT 1 FROM owned_grants g JOIN weaving_runs owned ON owned.id=g.run_id WHERE owned.job_id=j.id AND g.revoked=0)
  ) BEGIN SELECT RAISE(ABORT,'invalid abandonment scope'); END`);
  db.run(`CREATE TRIGGER weaving_abandonment_immutable BEFORE UPDATE ON weaving_abandonments
    BEGIN SELECT RAISE(ABORT,'immutable abandonment receipt'); END`);
  db.run(`CREATE TRIGGER weaving_abandonment_retained BEFORE DELETE ON weaving_abandonments
    BEGIN SELECT RAISE(ABORT,'retained abandonment receipt'); END`);
  db.run(`CREATE TABLE weaving_abandonment_dispatch (
    abandonment_id TEXT PRIMARY KEY NOT NULL REFERENCES weaving_abandonments(id),
    state TEXT NOT NULL CHECK(state IN ('queued','attempted','requested','uncertain','not_requested')),
    attempted_at INTEGER, finished_at INTEGER,
    category TEXT CHECK(category IN ('unsupported','ownership_unverified','request_failed')),
    CHECK((state='queued' AND attempted_at IS NULL AND finished_at IS NULL AND category IS NULL)
      OR (state='attempted' AND attempted_at IS NOT NULL AND attempted_at>=0 AND finished_at IS NULL AND category IS NULL)
      OR (state IN ('requested','uncertain','not_requested') AND attempted_at IS NOT NULL AND finished_at IS NOT NULL AND finished_at>=attempted_at)),
    CHECK((state IN ('queued','attempted','requested') AND category IS NULL)
      OR (state='uncertain' AND category IS 'request_failed')
      OR (state='not_requested' AND category IS NOT NULL AND category IN ('unsupported','ownership_unverified')))
  )`);
  db.run(`CREATE TRIGGER abandonment_dispatch_scope BEFORE INSERT ON weaving_abandonment_dispatch WHEN NEW.state<>'queued' OR NOT EXISTS (
    SELECT 1 FROM weaving_abandonments a JOIN jobs j ON j.id=a.job_id WHERE a.id=NEW.abandonment_id AND j.status='abandoned'
  ) BEGIN SELECT RAISE(ABORT,'invalid abandonment dispatch'); END`);
  db.run(`CREATE TRIGGER abandonment_dispatch_identity BEFORE UPDATE OF abandonment_id ON weaving_abandonment_dispatch
    BEGIN SELECT RAISE(ABORT,'immutable abandonment dispatch identity'); END`);
  db.run(`CREATE TRIGGER abandonment_dispatch_forward BEFORE UPDATE ON weaving_abandonment_dispatch WHEN NOT (
    (OLD.state='queued' AND NEW.state='attempted' AND NEW.attempted_at IS NOT NULL AND NEW.attempted_at>=0 AND NEW.finished_at IS NULL AND NEW.category IS NULL)
    OR (OLD.state='attempted' AND NEW.state IN ('requested','uncertain','not_requested')
      AND NEW.attempted_at=OLD.attempted_at AND NEW.finished_at IS NOT NULL AND NEW.finished_at>=NEW.attempted_at)
  ) BEGIN SELECT RAISE(ABORT,'retained abandonment interrupt attempt'); END`);
  db.run(`CREATE TRIGGER abandonment_dispatch_retained BEFORE DELETE ON weaving_abandonment_dispatch
    BEGIN SELECT RAISE(ABORT,'retained abandonment dispatch'); END`);
  db.run(`CREATE TRIGGER abandoned_job_final BEFORE UPDATE OF status ON jobs WHEN OLD.status='abandoned' AND NEW.status<>'abandoned'
    BEGIN SELECT RAISE(ABORT,'abandoned job is terminal'); END`);
  db.run(`CREATE TRIGGER abandoned_job_retained BEFORE DELETE ON jobs WHEN OLD.status='abandoned'
    BEGIN SELECT RAISE(ABORT,'retained abandoned job'); END`);
  db.run(`CREATE TRIGGER abandoned_run_frozen BEFORE UPDATE ON weaving_runs WHEN
    EXISTS (SELECT 1 FROM jobs j WHERE j.id=OLD.job_id AND j.status='abandoned')
    OR EXISTS (SELECT 1 FROM weaving_abandonments a WHERE a.run_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'abandoned run lifecycle is frozen'); END`);
  db.run(`CREATE TRIGGER abandoned_job_no_run BEFORE INSERT ON weaving_runs WHEN
    EXISTS (SELECT 1 FROM jobs j WHERE j.id=NEW.job_id AND j.status='abandoned')
    OR EXISTS (SELECT 1 FROM weaving_abandonments a WHERE a.job_id=NEW.job_id)
    BEGIN SELECT RAISE(ABORT,'abandoned job cannot acquire a run'); END`);
  db.run(`CREATE TRIGGER abandoned_job_no_grant BEFORE INSERT ON owned_grants WHEN EXISTS (
    SELECT 1 FROM weaving_runs r JOIN jobs j ON j.id=r.job_id WHERE r.id=NEW.run_id
      AND (j.status='abandoned' OR EXISTS (SELECT 1 FROM weaving_abandonments a WHERE a.job_id=j.id))
  ) BEGIN SELECT RAISE(ABORT,'abandoned job cannot acquire a grant'); END`);
  for (const action of ["INSERT", "UPDATE"] as const) {
    db.run(`CREATE TRIGGER abandoned_command_${action.toLowerCase()} BEFORE ${action} ON native_commands WHEN EXISTS (
      SELECT 1 FROM weaving_runs r JOIN jobs j ON j.id=r.job_id WHERE r.id=NEW.run_id
        AND (j.status='abandoned' OR EXISTS (SELECT 1 FROM weaving_abandonments a WHERE a.run_id=r.id))
    ) BEGIN SELECT RAISE(ABORT,'abandoned native command is frozen'); END`);
  }
  db.run(`CREATE TRIGGER abandoned_dialogue_no_outcome BEFORE INSERT ON dialogue_outcomes WHEN EXISTS (
    SELECT 1 FROM weaving_runs r JOIN jobs j ON j.id=r.job_id WHERE r.id=NEW.run_id
      AND (j.status='abandoned' OR EXISTS (SELECT 1 FROM weaving_abandonments a WHERE a.run_id=r.id))
  ) BEGIN SELECT RAISE(ABORT,'abandonment is not native settlement'); END`);
}

/** No run FK: cancellation-only identity must survive local content/run purge. */
export const searchCleanupTable = `CREATE TABLE search_native_cleanup (
  run_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES search_sessions(id),
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
  last_prompt_id TEXT NOT NULL,
  submit_owner TEXT,
  drain_state TEXT NOT NULL CHECK(drain_state IN ('waiting','drained','unknown-after-restart')),
  admission_state TEXT NOT NULL CHECK(admission_state IN ('never-submitted','uncertain','admitted','terminal')),
  prompt_sha256 BLOB,
  evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)),
  state TEXT NOT NULL CHECK(state IN ('pending','settled','ownership-conflict')),
  prompt_manifest_json TEXT CHECK(prompt_manifest_json IS NULL OR json_valid(prompt_manifest_json)),
  CHECK(prompt_sha256 IS NULL OR (typeof(prompt_sha256)='blob' AND length(prompt_sha256)=32)),
  CHECK(admission_state='never-submitted' OR prompt_sha256 IS NOT NULL
    OR (drain_state='unknown-after-restart' AND state IN ('pending','ownership-conflict'))),
  CHECK(admission_state!='terminal' OR (prompt_sha256 IS NOT NULL AND evidence_json IS NOT NULL)),
  CHECK(state!='settled' OR (drain_state='drained' AND admission_state IN ('never-submitted','terminal')))
)`;

/** These owned definitions change deliberately; all other cleanup indexes/triggers survive migration verbatim. */
export const searchCleanupGuardNames = ["search_native_cleanup_identity_immutable","search_native_cleanup_no_replace",
  "search_native_cleanup_owner","search_native_cleanup_transition","search_native_cleanup_settled_delete",
  "search_native_cleanup_manifest","search_native_cleanup_proof"] as const;

function object(value: string, keys: readonly string[]): string {
  return `(json_type(${value}) IS NOT 'object' OR (SELECT COUNT(*) FROM json_each(${value}))!=${keys.length}
    OR EXISTS (SELECT 1 FROM json_each(${value}) WHERE key NOT IN (${keys.map(key => `'${key}'`).join(",")})))`;
}
const manifest = "NEW.prompt_manifest_json";
const focus = `(SELECT value FROM json_each(${manifest},'$.steps')
  ORDER BY (json_extract(value,'$.authorization')!='never-authorized') DESC,CAST(key AS INTEGER) DESC LIMIT 1)`;
const uncertain = `EXISTS (SELECT 1 FROM json_each(${manifest},'$.steps') WHERE json_extract(value,'$.authorization')!='never-authorized')`;
const unqualified = `(NOT EXISTS (SELECT 1 FROM execution_owners WHERE id=json_extract(${manifest},'$.setupOwnerId'))
  OR EXISTS (SELECT 1 FROM json_each(${manifest},'$.steps') j WHERE json_extract(j.value,'$.authorization')='unattributed'
    OR (json_extract(j.value,'$.authorization')='authorized-uncertain' AND
      (json_type(j.value,'$.inputSha256') IS NOT 'text' OR NOT EXISTS (
        SELECT 1 FROM execution_owners issuer JOIN execution_owners setup
        ON issuer.database_identity=setup.database_identity AND issuer.lease_protocol=setup.lease_protocol
        WHERE issuer.id=json_extract(j.value,'$.submitOwnerId') AND setup.id=json_extract(${manifest},'$.setupOwnerId'))))))`;

/** Necessary metadata checks only. SQL cannot verify a remote terminal certificate or a real joined execution flight. */
export const searchCleanupGuards = `
  CREATE TRIGGER search_native_cleanup_identity_immutable BEFORE UPDATE OF rowid,_rowid_,oid,
    run_id,session_id,binding_json,last_prompt_id,submit_owner,prompt_sha256,prompt_manifest_json ON search_native_cleanup
  BEGIN SELECT RAISE(ABORT,'search cleanup identity immutable'); END;
  CREATE TRIGGER search_native_cleanup_no_replace BEFORE INSERT ON search_native_cleanup
  WHEN EXISTS (SELECT 1 FROM search_native_cleanup WHERE rowid=NEW.rowid OR run_id=NEW.run_id)
  BEGIN SELECT RAISE(ABORT,'search cleanup cannot be replaced'); END;
  CREATE TRIGGER search_native_cleanup_owner BEFORE INSERT ON search_native_cleanup
  WHEN NOT EXISTS (SELECT 1 FROM runs r JOIN search_turns t ON t.run_id=r.id JOIN search_sessions s ON s.id=t.session_id
    WHERE r.id=NEW.run_id AND r.kind='search' AND t.session_id=NEW.session_id AND
      (s.deleted_at IS NOT NULL OR (r.status IN ('completed','interrupted','failed') AND r.cancellation_state='pending' AND t.open_slot=0)))
    OR NOT EXISTS (SELECT 1 FROM run_steps WHERE run_id=NEW.run_id AND prompt_id=NEW.last_prompt_id)
  BEGIN SELECT RAISE(ABORT,'search cleanup requires its tombstoned or terminal pending search owner'); END;

  CREATE TRIGGER search_native_cleanup_manifest BEFORE INSERT ON search_native_cleanup
  WHEN NEW.prompt_manifest_json IS NULL OR NEW.state!='pending' OR NEW.drain_state='drained'
    OR NEW.evidence_json IS NOT NULL OR NEW.admission_state NOT IN ('never-submitted','uncertain')
    OR ${object("NEW.binding_json",["sessionId","serviceUrl","location","model","permissions","protocolVersion"])}
    OR ${object("json_extract(NEW.binding_json,'$.location')",["directory"])}
    OR json_type(NEW.binding_json,'$.model') IS NOT 'object'
    OR json_type(NEW.binding_json,'$.model.providerID') IS NOT 'text' OR json_type(NEW.binding_json,'$.model.id') IS NOT 'text'
    OR EXISTS (SELECT 1 FROM json_each(NEW.binding_json,'$.model') WHERE key NOT IN ('providerID','id','variant'))
    OR json_type(NEW.binding_json,'$.permissions') IS NOT 'array'
    OR NOT EXISTS (SELECT 1 FROM json_each(NEW.binding_json,'$.permissions') WHERE json_extract(value,'$.action')='*'
      AND json_extract(value,'$.resource')='*' AND json_extract(value,'$.effect')='deny')
    OR EXISTS (SELECT 1 FROM json_each(NEW.binding_json,'$.permissions') j WHERE
      ${object("j.value",["action","resource","effect"])} OR json_extract(j.value,'$.effect') IS NOT 'deny')
    OR ${object(manifest,["version","runId","searchSessionId","nativeSessionId","fencedGeneration","setupOwnerId","steps"])}
    OR json_extract(${manifest},'$.version') IS NOT 1 OR json_type(${manifest},'$.version') IS NOT 'integer'
    OR json_type(${manifest},'$.runId') IS NOT 'text' OR json_extract(${manifest},'$.runId') IS NOT NEW.run_id
    OR json_type(${manifest},'$.searchSessionId') IS NOT 'text' OR json_extract(${manifest},'$.searchSessionId') IS NOT NEW.session_id
    OR json_type(${manifest},'$.nativeSessionId') IS NOT 'text'
    OR json_type(${manifest},'$.fencedGeneration') IS NOT 'integer'
    OR json_extract(${manifest},'$.fencedGeneration') NOT BETWEEN 0 AND 9007199254740991
    OR COALESCE(json_type(${manifest},'$.setupOwnerId'),'') NOT IN ('text','null')
    OR json_type(${manifest},'$.steps') IS NOT 'array' OR json_array_length(${manifest},'$.steps')=0
    OR NOT EXISTS (SELECT 1 FROM runs r JOIN agent_bindings b ON b.run_id=r.id WHERE r.id=NEW.run_id
      AND json_extract(${manifest},'$.nativeSessionId')=r.session_id AND b.session_id=r.session_id
      AND json_extract(${manifest},'$.fencedGeneration')=r.generation
      AND json_extract(${manifest},'$.setupOwnerId') IS b.execution_owner_id
      AND json_extract(NEW.binding_json,'$.sessionId') IS b.session_id
      AND json_extract(NEW.binding_json,'$.serviceUrl') IS b.service_url
      AND json_extract(NEW.binding_json,'$.location.directory') IS b.directory
      AND json_extract(NEW.binding_json,'$.protocolVersion') IS b.protocol_version
      AND NOT EXISTS (SELECT fullkey,type,atom FROM json_tree(json_extract(NEW.binding_json,'$.model'))
        EXCEPT SELECT fullkey,type,atom FROM json_tree(b.model_json))
      AND NOT EXISTS (SELECT fullkey,type,atom FROM json_tree(b.model_json)
        EXCEPT SELECT fullkey,type,atom FROM json_tree(json_extract(NEW.binding_json,'$.model')))
      AND NOT EXISTS (SELECT fullkey,type,atom FROM json_tree(json_extract(NEW.binding_json,'$.permissions'))
        EXCEPT SELECT fullkey,type,atom FROM json_tree(b.permissions_json))
      AND NOT EXISTS (SELECT fullkey,type,atom FROM json_tree(b.permissions_json)
        EXCEPT SELECT fullkey,type,atom FROM json_tree(json_extract(NEW.binding_json,'$.permissions'))))
    OR json_array_length(${manifest},'$.steps')!=(SELECT COUNT(*) FROM run_steps WHERE run_id=NEW.run_id)
    OR EXISTS (SELECT 1 FROM json_each(${manifest},'$.steps') j WHERE
      ${object("j.value",["position","promptId","inputSha256","submitOwnerId","authorization","state","nativeState"])}
      OR json_type(j.value,'$.position') IS NOT 'integer' OR json_extract(j.value,'$.position') IS NOT CAST(j.key AS INTEGER)
      OR json_type(j.value,'$.promptId') IS NOT 'text'
      OR COALESCE(json_type(j.value,'$.inputSha256'),'') NOT IN ('text','null')
      OR (json_type(j.value,'$.inputSha256')='text' AND (length(json_extract(j.value,'$.inputSha256'))!=64
        OR json_extract(j.value,'$.inputSha256') GLOB '*[^0-9a-f]*'))
      OR COALESCE(json_type(j.value,'$.submitOwnerId'),'') NOT IN ('text','null')
      OR (json_type(j.value,'$.submitOwnerId')='text' AND length(json_extract(j.value,'$.submitOwnerId'))=0)
      OR NOT EXISTS (SELECT 1 FROM run_steps p WHERE p.run_id=NEW.run_id AND p.position=CAST(j.key AS INTEGER)
        AND json_extract(j.value,'$.promptId') IS p.prompt_id AND json_extract(j.value,'$.submitOwnerId') IS p.submit_owner
        AND json_extract(j.value,'$.state') IS p.state AND json_extract(j.value,'$.nativeState') IS p.native_state
        AND (json_type(j.value,'$.inputSha256')='null')=(p.input IS NULL)
        AND json_extract(j.value,'$.authorization') IS CASE WHEN p.state='prepared' AND p.native_state='unknown'
          AND p.submit_owner IS NULL AND p.envelope_json IS NULL AND p.result_json IS NULL THEN 'never-authorized'
          WHEN p.state!='prepared' AND p.submit_owner IS NOT NULL THEN 'authorized-uncertain'
          WHEN p.state!='prepared' AND p.submit_owner IS NULL THEN 'unattributed' ELSE '' END))
    OR NEW.last_prompt_id IS NOT json_extract(${focus},'$.promptId')
    OR NEW.submit_owner IS NOT json_extract(${focus},'$.submitOwnerId')
    OR (NEW.prompt_sha256 IS NULL)!=(json_type(${focus},'$.inputSha256')='null')
    OR (NEW.prompt_sha256 IS NOT NULL AND lower(hex(NEW.prompt_sha256)) IS NOT json_extract(${focus},'$.inputSha256'))
    OR NEW.admission_state!=CASE WHEN ${uncertain} THEN 'uncertain' ELSE 'never-submitted' END
    OR (NEW.drain_state!='unknown-after-restart' AND ${unqualified})
  BEGIN SELECT RAISE(ABORT,'search cleanup requires its complete immutable journal manifest'); END;

  CREATE TRIGGER search_native_cleanup_transition BEFORE UPDATE ON search_native_cleanup
  WHEN OLD.state='settled' OR (OLD.drain_state='drained' AND NEW.drain_state!='drained')
    OR (OLD.drain_state='unknown-after-restart' AND NEW.drain_state='waiting')
    OR CASE NEW.admission_state WHEN 'never-submitted' THEN 0 WHEN 'uncertain' THEN 1 WHEN 'admitted' THEN 2 ELSE 3 END
      < CASE OLD.admission_state WHEN 'never-submitted' THEN 0 WHEN 'uncertain' THEN 1 WHEN 'admitted' THEN 2 ELSE 3 END
    OR (NEW.prompt_manifest_json IS NOT NULL AND NEW.admission_state IN ('admitted','terminal') AND NOT ${uncertain})
    OR (OLD.admission_state='terminal' AND NEW.evidence_json IS NOT OLD.evidence_json)
  BEGIN SELECT RAISE(ABORT,'search cleanup evidence cannot regress'); END;

  CREATE TRIGGER search_native_cleanup_proof BEFORE UPDATE ON search_native_cleanup
  WHEN (NEW.drain_state='drained' OR NEW.admission_state='terminal' OR NEW.state='settled') AND (
    NEW.prompt_manifest_json IS NULL OR json_type(NEW.evidence_json) IS NOT 'object'
    OR json_extract(NEW.evidence_json,'$.version') IS NOT 1
    OR json_type(NEW.evidence_json,'$.drainOwnerId') IS NOT 'text'
    OR NOT EXISTS (SELECT 1 FROM execution_owners setup JOIN execution_owners drainer
      ON drainer.database_identity=setup.database_identity AND drainer.lease_protocol=setup.lease_protocol
      WHERE setup.id=json_extract(${manifest},'$.setupOwnerId') AND drainer.id=json_extract(NEW.evidence_json,'$.drainOwnerId'))
    OR ${unqualified}
    OR ((NEW.admission_state='terminal' OR NEW.state='settled') AND ${uncertain} AND (
      NEW.admission_state!='terminal' OR json_type(NEW.evidence_json,'$.inboxEmpty') IS NOT 'true'
      OR json_type(NEW.evidence_json,'$.inactive') IS NOT 'true'
      OR json_type(NEW.evidence_json,'$.prompts') IS NOT 'array'
      OR json_array_length(NEW.evidence_json,'$.prompts')!=(SELECT COUNT(*) FROM json_each(${manifest},'$.steps')
        WHERE json_extract(value,'$.authorization')='authorized-uncertain')
      OR EXISTS (SELECT 1 FROM json_each(${manifest},'$.steps') j WHERE json_extract(j.value,'$.authorization')='authorized-uncertain'
        AND NOT EXISTS (SELECT 1 FROM json_each(NEW.evidence_json,'$.prompts') e
          WHERE json_extract(e.value,'$.promptId') IS json_extract(j.value,'$.promptId')
            AND json_extract(e.value,'$.inputSha256') IS json_extract(j.value,'$.inputSha256')
            AND json_extract(e.value,'$.userMessageId') IS json_extract(j.value,'$.promptId')
            AND json_type(e.value,'$.idleMessageId')='text' AND length(json_extract(e.value,'$.idleMessageId'))>0
            AND COALESCE(json_type(e.value,'$.assistantMessageId'),'') IN ('text','null')
            AND json_extract(e.value,'$.outcome') IN ('completed','failed','interrupted'))))))
  BEGIN SELECT RAISE(ABORT,'search cleanup needs qualified drain and matching terminal metadata'); END;
  CREATE TRIGGER search_native_cleanup_settled_delete BEFORE DELETE ON search_native_cleanup
  WHEN OLD.state!='settled'
  BEGIN SELECT RAISE(ABORT,'unsettled search cleanup must be retained'); END;
`;

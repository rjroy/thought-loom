import type { Database } from "bun:sqlite";
import type { BackgroundItem, BackgroundPosition, BackgroundTarget, BackgroundView, BackgroundWorkRepository } from "../domain/background-work";
import type { Logger } from "../logging";
import { unfencedImportFileSql } from "./import-authority";
import { recordedSubjectCancellationSafeSql } from "./run-cancellation";
import type { LocalStopController } from "../domain/local-work-stop";
import { localRunStoppedSql, localFileStoppedSql } from "./local-work-stop-fence";

type Row = {
  type: BackgroundTarget["type"]; id: string; kind: BackgroundItem["kind"]; status: BackgroundItem["status"];
  createdAt: string | null; ownerType: BackgroundItem["owner"]["type"]; ownerId: string | null; title: string | null;
  reason: BackgroundItem["reason"]; view: BackgroundView | null;
};

// Project only control metadata. In particular no execution journals, import paths or content leave SQLite.
const projection = `WITH work AS (
  SELECT 'run' AS type,r.id,r.kind,r.status,r.created_at AS createdAt,
    CASE WHEN r.kind IN ('weave','evolve') AND COALESCE(r.weave_subject_id,r.input_thought_id,et.parent_id) IS NOT NULL THEN 'thought'
      WHEN r.kind='search' THEN 'search-session' WHEN r.kind='import' THEN 'import'
      WHEN r.kind='export' THEN 'export' ELSE 'unknown' END AS ownerType,
    CASE WHEN r.kind IN ('weave','evolve') THEN COALESCE(r.weave_subject_id,r.input_thought_id,et.parent_id)
      WHEN r.kind='search' THEN COALESCE(st.session_id,sc.session_id)
      WHEN r.kind='import' THEN f.import_id WHEN r.kind='export' THEN r.id END AS ownerId,
    CASE WHEN r.kind IN ('weave','evolve') AND rt.thought_id IS NULL THEN tt.title
      WHEN r.kind='search' AND ss.deleted_at IS NULL THEN ss.title END AS title,
    CASE WHEN sc.state='ownership-conflict' THEN 'ownership-conflict'
      WHEN sc.state='pending' OR r.cancellation_state='pending' THEN 'cancellation-pending'
      WHEN r.status='uncertain' THEN 'uncertain'
      WHEN r.kind IN ('weave','evolve') AND r.status IN ('failed','interrupted')
        AND r.cancellation_state='settled' AND NOT ${recordedSubjectCancellationSafeSql} THEN 'unverified'
      WHEN r.status='failed' THEN 'failed'
      WHEN r.status='interrupted' THEN 'interrupted' ELSE NULL END AS reason,
    CASE WHEN ${localRunStoppedSql("r.id")} THEN 'locally-closed'
      WHEN EXISTS(SELECT 1 FROM restore_fences rf WHERE rf.entity_kind='run' AND rf.entity_id=r.id) THEN NULL
      WHEN r.kind='import' AND f.id IS NOT NULL AND NOT ${unfencedImportFileSql} THEN NULL
      WHEN sc.state IN ('pending','ownership-conflict') OR r.cancellation_state='pending' OR r.status IN ('uncertain','failed','interrupted') THEN 'needs-attention'
      WHEN r.status IN ('queued','submitting','running') THEN 'in-progress' ELSE NULL END AS view
  FROM runs r
  LEFT JOIN evolve_turns et ON et.run_id=r.id
  LEFT JOIN search_turns st ON st.run_id=r.id
  LEFT JOIN search_native_cleanup sc ON sc.run_id=r.id
  LEFT JOIN search_sessions ss ON ss.id=COALESCE(st.session_id,sc.session_id)
  LEFT JOIN markdown_import_files f ON f.run_id=r.id
  LEFT JOIN thought_titles tt ON tt.thought_id=COALESCE(r.weave_subject_id,r.input_thought_id,et.parent_id)
  LEFT JOIN rejected_thoughts rt ON rt.thought_id=tt.thought_id
  UNION ALL
  SELECT 'run',sc.run_id,'search',sc.state,NULL,'search-session',sc.session_id,
    CASE WHEN ss.deleted_at IS NULL THEN ss.title END,
    CASE WHEN sc.state='ownership-conflict' THEN 'ownership-conflict' WHEN sc.state='pending' THEN 'cancellation-pending' END,
    CASE WHEN ${localRunStoppedSql("sc.run_id")} THEN 'locally-closed'
      WHEN sc.state IN ('pending','ownership-conflict') AND NOT EXISTS(
      SELECT 1 FROM restore_fences rf WHERE rf.entity_kind='run' AND rf.entity_id=sc.run_id) THEN 'needs-attention' END
  FROM search_native_cleanup sc JOIN search_sessions ss ON ss.id=sc.session_id
  WHERE NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=sc.run_id)
  UNION ALL
  SELECT 'import-file',f.id,'import',COALESCE(f.outcome,ir.status,'waiting'),f.created_at,'import',f.import_id,NULL,
    CASE WHEN f.outcome='failed' THEN 'failed' WHEN f.outcome='interrupted' THEN 'interrupted'
      WHEN f.outcome IS NULL AND ir.cancellation_state='pending' THEN 'cancellation-pending'
      WHEN f.outcome IS NULL AND ir.status='uncertain' THEN 'uncertain'
      WHEN f.outcome IS NULL AND ir.status='failed' THEN 'failed'
      WHEN f.outcome IS NULL AND ir.status='interrupted' THEN 'interrupted'
      WHEN f.outcome IS NULL AND f.run_id IS NULL THEN 'waiting' END,
    CASE WHEN f.run_id IS NOT NULL THEN NULL
      WHEN ${localFileStoppedSql("f.id")} THEN 'locally-closed'
      WHEN NOT ${unfencedImportFileSql} THEN NULL
      WHEN f.outcome IN ('failed','interrupted') THEN 'needs-attention'
      WHEN f.outcome IS NULL THEN 'in-progress' END
   FROM markdown_import_files f LEFT JOIN runs ir ON ir.id=f.run_id
   UNION ALL
   SELECT s.target_kind,s.target_id,
     CASE WHEN s.target_kind='run' THEN json_extract(s.identity_json,'$.kind') ELSE 'import' END,
     'interrupted',NULL,'unknown',NULL,NULL,NULL,'locally-closed'
   FROM local_work_stops s WHERE
     (s.run_id IS NULL OR NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=s.run_id))
     AND (s.import_file_id IS NULL OR NOT EXISTS(SELECT 1 FROM markdown_import_files f WHERE f.id=s.import_file_id))
     AND (s.run_id IS NULL OR NOT EXISTS(SELECT 1 FROM search_native_cleanup sc WHERE sc.run_id=s.run_id))
)`;

function item(row: Row, authority:boolean): BackgroundItem {
  return {target:{type:row.type,id:row.id},kind:row.kind,status:row.status,createdAt:row.createdAt,
    owner:{type:row.ownerType,id:row.ownerId,title:row.title},reason:row.reason,
    actions:{checkStatus:true,stopLocalTracking:authority && row.view !== null && row.view !== "locally-closed"}};
}

export class SqliteBackgroundWork implements BackgroundWorkRepository {
  constructor(private readonly db: Database, private readonly logger: Logger,private readonly localStops?:LocalStopController) {}
  summary(): Record<BackgroundView, number> {
    this.logger.verbose("[background work] summary read attempt");
    const counts: Record<BackgroundView, number> = {"needs-attention":0,"in-progress":0,"locally-closed":0};
    const rows = this.db.query<{view:BackgroundView; count:number},[]>(`${projection} SELECT view,COUNT(*) AS count FROM work WHERE view IS NOT NULL GROUP BY view`).all();
    for (const row of rows) counts[row.view] = row.count;
    this.logger.verbose("[background work] summary read outcome");
    return counts;
  }
  list(view: BackgroundView, limit: number, after?: BackgroundPosition): {items: BackgroundItem[]; hasMore: boolean} {
    this.logger.verbose("[background work] page read attempt", {view});
    const rows = this.db.query<Row, [string,number,string,string,string,number]>(`${projection}
      SELECT * FROM work WHERE view=?1 AND (?2=0 OR
        (CASE WHEN createdAt IS NULL THEN 1 ELSE 0 END,COALESCE(createdAt,''),type,id) > (?2-1,?3,?4,?5))
      ORDER BY createdAt IS NULL,createdAt,type,id LIMIT ?6`)
      .all(view,after ? (after.createdAt === null ? 2 : 1) : 0,after?.createdAt ?? "",after?.type ?? "",after?.id ?? "",limit+1);
    this.logger.verbose("[background work] page read outcome", {view});
    return {items:rows.slice(0,limit).map(row => item(row,this.localStops !== undefined)),hasMore:rows.length>limit};
  }
  get(target: BackgroundTarget): BackgroundItem | null {
    this.logger.verbose("[background work] detail read attempt", {type:target.type});
    const row = this.db.query<Row,[string,string]>(`${projection} SELECT * FROM work WHERE type=? AND id=?`).get(target.type,target.id);
    this.logger.verbose("[background work] detail read outcome", {type:target.type,found:row !== null});
    if (!row) return null;
    const snapshot=this.localStops?.snapshot(target);
    return {...item(row,this.localStops !== undefined),...(snapshot ? {localStop:snapshot,actions:{checkStatus:true,stopLocalTracking:snapshot.eligible}} : {})};
  }
}

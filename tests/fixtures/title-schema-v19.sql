-- Fixed historical test fixture, extracted unchanged from fuzzy-projection.test.ts.
CREATE TABLE title_entities (id TEXT PRIMARY KEY NOT NULL, source_id TEXT REFERENCES sources(id), item_id TEXT REFERENCES knowledge_items(id), CHECK((source_id IS NULL) <> (item_id IS NULL)), UNIQUE(source_id), UNIQUE(item_id));
CREATE TRIGGER title_entity_immutable BEFORE UPDATE ON title_entities BEGIN SELECT RAISE(ABORT,'immutable title entity'); END;
CREATE TRIGGER title_entity_retained BEFORE DELETE ON title_entities BEGIN SELECT RAISE(ABORT,'retained title entity'); END;
CREATE TABLE title_revisions (id TEXT PRIMARY KEY NOT NULL, entity_id TEXT NOT NULL REFERENCES title_entities(id), text TEXT NOT NULL, author TEXT NOT NULL CHECK(author IN ('user','ai')), formulation_id TEXT REFERENCES formulations(id), created_at TEXT NOT NULL, UNIQUE(entity_id,id));
CREATE TRIGGER title_revision_scope BEFORE INSERT ON title_revisions WHEN (NEW.formulation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM title_entities e JOIN formulations f ON f.item_id=e.item_id WHERE e.id=NEW.entity_id AND f.id=NEW.formulation_id)) OR (NEW.author='ai' AND EXISTS (SELECT 1 FROM title_entities e WHERE e.id=NEW.entity_id AND e.item_id IS NOT NULL) AND NEW.formulation_id IS NULL) BEGIN SELECT RAISE(ABORT,'invalid title formulation'); END;
CREATE TRIGGER title_revision_immutable BEFORE UPDATE ON title_revisions BEGIN SELECT RAISE(ABORT,'immutable title revision'); END;
CREATE TRIGGER title_revision_retained BEFORE DELETE ON title_revisions BEGIN SELECT RAISE(ABORT,'retained title revision'); END;
CREATE TABLE title_heads (entity_id TEXT PRIMARY KEY REFERENCES title_entities(id), revision_id TEXT NOT NULL, user_revision_id TEXT, FOREIGN KEY(entity_id,revision_id) REFERENCES title_revisions(entity_id,id), FOREIGN KEY(entity_id,user_revision_id) REFERENCES title_revisions(entity_id,id));
CREATE TRIGGER title_head_user_insert BEFORE INSERT ON title_heads WHEN NEW.user_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM title_revisions r WHERE r.id=NEW.user_revision_id AND r.entity_id=NEW.entity_id AND r.author='user') BEGIN SELECT RAISE(ABORT,'invalid title user override'); END;
CREATE TRIGGER title_head_user_update BEFORE UPDATE ON title_heads WHEN NEW.user_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM title_revisions r WHERE r.id=NEW.user_revision_id AND r.entity_id=NEW.entity_id AND r.author='user') BEGIN SELECT RAISE(ABORT,'invalid title user override'); END;
CREATE TABLE title_receipts (idempotency_key TEXT PRIMARY KEY NOT NULL, payload_hash TEXT NOT NULL, revision_id TEXT NOT NULL REFERENCES title_revisions(id));
CREATE TRIGGER title_receipt_immutable BEFORE UPDATE ON title_receipts BEGIN SELECT RAISE(ABORT,'immutable title receipt'); END;
CREATE TRIGGER title_receipt_retained BEFORE DELETE ON title_receipts BEGIN SELECT RAISE(ABORT,'retained title receipt'); END;
CREATE VIRTUAL TABLE title_search USING fts5(entity_id UNINDEXED, text);
CREATE VIRTUAL TABLE title_vocabulary USING fts5vocab(title_search, 'row');
PRAGMA user_version=19;

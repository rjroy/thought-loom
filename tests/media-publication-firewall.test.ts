import { describe, expect, test } from "bun:test";
import { mediaAdmissionFixture, mediaAdmissionInput, mediaAttempts } from "./fixtures/media-admission";
import { expectGenericPublicationDenied, unjournaledMediaInterpretation } from "./fixtures/media-publication";

describe("media-root interpretation publication firewall", () => {
  test("generic thought persistence cannot publish a media-root interpretation", async () => mediaAdmissionFixture(f => {
    const input = mediaAdmissionInput(), admission = f.admissions.admit("user", input);
    expect(admission.replayed).toBe(false);
    expect(f.store.getThought(admission.thought.id)).toEqual(input.thought);
    expect(mediaAttempts(f.db)).toHaveLength(1);
    expect(mediaAttempts(f.db)[0]).toMatchObject({ source_id: input.thought.mediaSource.id, run_id: admission.run.id,
      position: 0, open_slot: 1, interpretation_thought_id: null });
    expect(f.db.query("SELECT input,state,native_state,media_submit_owner_id,media_submit_generation FROM run_steps WHERE run_id=?")
      .all(admission.run.id)).toEqual([{ input: null, state: "prepared", native_state: "unknown", media_submit_owner_id: null, media_submit_generation: null }]);
    expect(f.db.query("SELECT * FROM run_media_parts").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM agent_bindings").all()).toEqual([]);

    expectGenericPublicationDenied(f.db, f.other, f.store, unjournaledMediaInterpretation(admission.thought.id));

    expect(f.db.query("SELECT * FROM run_operation_receipts").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM run_issued_thoughts").all()).toEqual([]);
    expect(mediaAttempts(f.db)[0]).toMatchObject({ open_slot: 1, interpretation_thought_id: null });
  }));

  test("a metadata-only media root cannot bypass publication authority by having no initial attempt", async () => mediaAdmissionFixture(f => {
    const input = mediaAdmissionInput();
    f.store.saveMediaSource(input);
    expect(f.store.getThought(input.thought.id)).toEqual(input.thought);
    expect(mediaAttempts(f.db)).toEqual([]);
    expect(f.db.query("SELECT * FROM runs").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM run_steps").all()).toEqual([]);

    expectGenericPublicationDenied(f.db, f.other, f.store, unjournaledMediaInterpretation(input.thought.id));

    expect(mediaAttempts(f.db)).toEqual([]);
    expect(f.db.query("SELECT * FROM run_operation_receipts").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM run_issued_thoughts").all()).toEqual([]);
  }));
});

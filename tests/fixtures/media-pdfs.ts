import { PDFDict, PDFDocument, PDFName, PDFRef, PDFString, type PDFObject } from "@cantoo/pdf-lib";
import type { PdfValidationLimits } from "../../src/storage/media-pdf-validation";

export const pdfLimits: PdfValidationLimits = Object.freeze({maxBytes:32768,maxPages:4,maxObjects:1024,maxDepth:64});
export const strictPdfLoad = Object.freeze({throwOnInvalidObject:true,updateMetadata:false,ignoreEncryption:false,preserveXFA:true});
export const pdfFixtureTitle = "Synthetic media validation fixture";
export const passiveUri = "https://example.invalid/media-validation-fixture";
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
export const encryptedPdfContent = text("% test-owned encrypted page content\nq\n0.25 g\n1 1 8 8 re\nf\nQ\n");
export const classicPageObjects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 16 16] /Resources << >> >>",
] as const;
/** Fixture-only independent writer: ASCII bodies with correct offsets, not a production PDF parser. */
export function classicPdf(objects: readonly string[] = classicPageObjects, wrongStartXref = false): Uint8Array {
  let output = "%PDF-1.7\n% test-owned classic PDF\n";
  const offsets = [0];
  objects.forEach((body,index) => { offsets.push(output.length); output += `${index+1} 0 obj\n${body}\nendobj\n`; });
  const xref = output.length;
  output += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${offset.toString().padStart(10,"0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${wrongStartXref ? 0 : xref}\n%%EOF\n`;
  return text(output);
}
export async function newPdf(pages = 1): Promise<PDFDocument> {
  const doc = await PDFDocument.create({updateMetadata:false});
  doc.setTitle(pdfFixtureTitle); doc.setProducer("Thoughtloom test fixture"); doc.setCreator("Thoughtloom test fixture");
  doc.setCreationDate(new Date("2032-02-03T04:05:06.000Z")); doc.setModificationDate(new Date("2032-02-03T04:05:06.000Z"));
  for (let page = 0; page < pages; page++) doc.addPage([16,16]);
  return doc;
}
export function savePdf(doc: PDFDocument, compressed = false): Promise<Uint8Array> {
  return doc.save({useObjectStreams:compressed,addDefaultPage:false,updateFieldAppearances:false});
}
export async function passiveLinkPdf(compressed: boolean): Promise<Uint8Array> {
  const doc = await newPdf(), page = doc.getPages()[0];
  if (!page) throw new Error("Missing controlled PDF page");
  const action = doc.context.register(doc.context.obj({S:"URI",URI:PDFString.of(passiveUri)}));
  const annotation = doc.context.register(doc.context.obj({Type:"Annot",Subtype:"Link",Rect:[0,0,8,8],A:action}));
  page.node.set(PDFName.of("Annots"),doc.context.obj([annotation]));
  return savePdf(doc,compressed);
}
export type ActionPlacement = "direct" | "chained" | "nested" | "unreachable" | "stream-dictionary";
export interface ActionPdfFixture {
  readonly bytes: Uint8Array;
  /** The action, or its containing dictionary/stream for direct nested actions. */
  readonly witness: PDFRef;
  readonly holder: PDFRef | null;
}
export async function actionPdf(actionKind: "JavaScript" | "Launch", placement: ActionPlacement,
  compressed: boolean): Promise<ActionPdfFixture> {
  const doc = await newPdf(), ctx = doc.context;
  const action = ctx.obj(actionKind === "JavaScript"
    ? {Type:"Action",S:"JavaScript",JS:PDFString.of("void('test-owned-script-sentinel')")}
    : {Type:"Action",S:"Launch",F:PDFString.of("test-owned-never-executed")});
  let witness: PDFRef, holder: PDFRef | null = null;
  if (placement === "nested") {
    witness = ctx.register(ctx.obj({Envelope:[{Action:action}]}));
    doc.catalog.set(PDFName.of("FixtureNested"),witness);
  } else if (placement === "stream-dictionary") {
    witness = ctx.register(ctx.stream("q Q",{Envelope:{Actions:[action]}}));
    doc.catalog.set(PDFName.of("FixtureStream"),witness);
  } else {
    witness = ctx.register(action);
    if (placement === "direct") doc.catalog.set(PDFName.of("OpenAction"),witness);
    if (placement === "chained") {
      holder = ctx.register(ctx.obj({S:"URI",URI:PDFString.of(passiveUri),Next:[witness]}));
      const page = doc.getPages()[0]; if (!page) throw new Error("Missing controlled PDF page");
      const annotation = ctx.register(ctx.obj({Type:"Annot",Subtype:"Link",Rect:[0,0,8,8],A:holder}));
      page.node.set(PDFName.of("Annots"),ctx.obj([annotation]));
    }
    // Unreachable objects intentionally remain in the context and serialized file.
  }
  return {bytes:await savePdf(doc,compressed),witness,holder};
}
export async function embeddedPdf(mode: "type-only" | "ef-only", compressed: boolean): Promise<{
  readonly bytes: Uint8Array; readonly witness: PDFRef; readonly payload: PDFRef;
}> {
  const doc = await newPdf(), ctx = doc.context;
  const payload = ctx.register(ctx.stream("test-owned-embedded-payload",mode === "type-only" ? {Type:"EmbeddedFile"} : {}));
  const witness = mode === "type-only" ? payload : ctx.register(ctx.obj({Type:"Filespec",F:PDFString.of("fixture.bin"),EF:{F:payload}}));
  if (mode === "ef-only") doc.catalog.set(PDFName.of("FixtureFilespec"),witness);
  return {bytes:await savePdf(doc,compressed),witness,payload};
}
export async function xfaPdf(): Promise<{ readonly bytes: Uint8Array; readonly form: PDFRef; readonly payload: PDFRef }> {
  const doc = await newPdf(), ctx = doc.context;
  const payload = ctx.register(ctx.stream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template>test-owned-xfa</template></xdp:xdp>'));
  const form = ctx.register(ctx.obj({Fields:[],XFA:payload}));
  doc.catalog.set(PDFName.of("AcroForm"),form);
  return {bytes:await savePdf(doc,true),form,payload};
}
export async function encryptedPdf(userPassword: string): Promise<Uint8Array> {
  // Cantoo's classic writer encrypts streams, not Info strings. Prove encryption with real page content instead.
  const doc = await PDFDocument.create({updateMetadata:false}), page = doc.addPage([16,16]);
  const contents = doc.context.register(doc.context.flateStream(encryptedPdfContent));
  page.node.set(PDFName.of("Contents"),contents);
  if (doc.context.trailerInfo.Info !== undefined) throw new Error("Minimal encryption fixture unexpectedly contains Info metadata");
  doc.encrypt({algorithm:"AES-256",ownerPassword:"test-owned-owner-password",userPassword,permissions:{copying:false,printing:false}});
  const bytes = await savePdf(doc,false);
  if (doc.context.trailerInfo.Info !== undefined) throw new Error("Saving the minimal encryption fixture introduced Info metadata");
  return bytes;
}
export async function danglingEncryptionPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({updateMetadata:false});
  doc.addPage([16,16]);
  // Public writer preserves a syntactically valid trailer whose security reference has no target.
  doc.context.trailerInfo.Encrypt = PDFRef.of(65000);
  return savePdf(doc,false);
}
export type GraphFixtureKind = "many-direct" | "deep" | "reference-cycle" | "dangling";
export async function graphPdf(kind: GraphFixtureKind): Promise<{ readonly bytes: Uint8Array; readonly witness: PDFRef }> {
  const doc = await newPdf(), ctx = doc.context;
  let witness: PDFRef;
  if (kind === "reference-cycle") {
    const left = ctx.obj({Value:PDFString.of("test-owned-cycle")}); witness = ctx.register(left);
    left.set(PDFName.of("Next"),ctx.register(ctx.obj({Back:witness})));
  } else {
    let value: PDFObject;
    if (kind === "many-direct") value = ctx.obj(Array.from({length:160},(_,index) => ctx.obj({Index:index})));
    else if (kind === "dangling") value = PDFRef.of(65000);
    else {
      value = PDFString.of("test-owned-deep-leaf");
      for (let depth = 0; depth < 24; depth++) value = ctx.obj([value]);
    }
    witness = ctx.register(ctx.obj({Value:value}));
  }
  doc.catalog.set(PDFName.of("FixtureGraph"),witness);
  return {bytes:await savePdf(doc,false),witness};
}
export type BadPageKind = "unresolved" | "cycle" | "duplicate" | "count-mismatch";
export async function badPagePdf(kind: BadPageKind): Promise<{ readonly bytes: Uint8Array; readonly tree: PDFRef }> {
  const doc = await newPdf(), ctx = doc.context, page = doc.getPages()[0];
  if (!page) throw new Error("Missing controlled PDF page");
  const tree = doc.catalog.get(PDFName.of("Pages"));
  if (!(tree instanceof PDFRef)) throw new Error("Controlled PDF has no indirect page tree");
  const pages = doc.catalog.lookup(PDFName.of("Pages"),PDFDict);
  if (kind === "unresolved") pages.set(PDFName.of("Kids"),ctx.obj([PDFRef.of(65000)]));
  if (kind === "cycle") pages.set(PDFName.of("Kids"),ctx.obj([tree]));
  if (kind === "duplicate") pages.set(PDFName.of("Kids"),ctx.obj([page.ref,page.ref]));
  if (kind === "duplicate" || kind === "count-mismatch") pages.set(PDFName.of("Count"),ctx.obj(2));
  // addDefaultPage:false is essential: never ask Cantoo to traverse this intentionally malformed page graph.
  return {bytes:await savePdf(doc,false),tree};
}
export function escapedActionPdf(): Uint8Array {
  return classicPdf([
    "<< /Type /Catalog /Pages 2 0 R /OpenAction 4 0 R >>",classicPageObjects[1],classicPageObjects[2],
    "<< /Type /Action /S /Java#53cript /#4aS (test-owned-escaped-script) >>",
  ]);
}
export function escapedEmbeddedPdf(): Uint8Array {
  return classicPdf([
    "<< /Type /Catalog /Pages 2 0 R /FixtureFilespec 4 0 R >>",classicPageObjects[1],classicPageObjects[2],
    "<< /Type /Filespec /F (fixture.bin) /E#46 << /F 5 0 R >> >>",
    "<< /Type /E#6dbeddedFile /Length 1 >>\nstream\nx\nendstream",
  ]);
}

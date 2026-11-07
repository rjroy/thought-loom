import { describe, expect, test } from "bun:test";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString,
  type PDFObject } from "@cantoo/pdf-lib";
import { validatePdfBytes, type PdfRejectionCode, type PdfValidationLimits, type PdfValidationResult } from "../src/storage/media-pdf-validation";
import { actionPdf, badPagePdf, classicPageObjects, classicPdf, danglingEncryptionPdf, embeddedPdf, encryptedPdf, encryptedPdfContent, escapedActionPdf,
  escapedEmbeddedPdf, graphPdf, newPdf, passiveLinkPdf, passiveUri, pdfFixtureTitle, pdfLimits, savePdf, strictPdfLoad, xfaPdf,
  type ActionPlacement } from "./fixtures/media-pdfs";

const accepted: PdfValidationResult = {ok:true,mimeType:"application/pdf"};
const rejected = (code: PdfRejectionCode): PdfValidationResult => ({ok:false,code});
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const ascii = (bytes: Uint8Array): string => new TextDecoder("latin1").decode(bytes);
function dictionary(value: PDFObject | undefined): PDFDict {
  if (!(value instanceof PDFDict)) throw new Error("Controlled fixture dictionary did not survive serialization");
  return value;
}
function rawStream(value: PDFObject | undefined): PDFRawStream {
  if (!(value instanceof PDFRawStream)) throw new Error("Controlled fixture stream did not survive serialization");
  return value;
}
function expectStringFreeEncryptionGraph(doc: PDFDocument, encryptionRef: PDFRef): void {
  // Security dictionary byte strings and trailer IDs are required encryption data, not document metadata.
  const pending = doc.context.enumerateIndirectObjects().filter(([ref]) => ref !== encryptionRef).map(([,value]) => value);
  const seen = new Set<PDFObject>();
  while (pending.length) {
    const value = pending.pop(); if (!value || seen.has(value) || value instanceof PDFRef) continue;
    seen.add(value);
    expect(value instanceof PDFString || value instanceof PDFHexString).toBe(false);
    if (value instanceof PDFRawStream) pending.push(value.dict);
    else if (value instanceof PDFDict) for (const [,child] of value.entries()) pending.push(child);
    else if (value instanceof PDFArray) for (let index = 0; index < value.size(); index++) pending.push(value.get(index));
  }
}
function objectStreams(doc: PDFDocument): PDFRawStream[] {
  return doc.context.enumerateIndirectObjects().flatMap(([,value]) => value instanceof PDFRawStream &&
    value.dict.lookup(PDFName.of("Type")) === PDFName.of("ObjStm") ? [value] : []);
}
function actionWitness(doc: PDFDocument, ref: PDFRef, placement: ActionPlacement): PDFDict {
  const value = doc.context.lookup(ref);
  if (placement === "nested") return dictionary(dictionary(value).lookup(PDFName.of("Envelope"),PDFArray).lookup(0,PDFDict).lookup(PDFName.of("Action")));
  if (placement === "stream-dictionary") return rawStream(value).dict.lookup(PDFName.of("Envelope"),PDFDict)
    .lookup(PDFName.of("Actions"),PDFArray).lookup(0,PDFDict);
  return dictionary(value);
}

describe("PDF structural validation core with controlled synthetic documents", () => {
  test("accepts an independent classic-xref PDF with a real one-page graph", async () => {
    await expect(validatePdfBytes(classicPdf(),pdfLimits)).resolves.toEqual(accepted);
  });

  test("the independent classic fixture has correct xref offsets and its expected page geometry", async () => {
    const bytes = classicPdf(), source = ascii(bytes), doc = await PDFDocument.load(bytes,strictPdfLoad);
    expect(doc.getPageCount()).toBe(1); expect(doc.getPage(0).getSize()).toEqual({width:16,height:16});
    const match = /startxref\n(\d+)\n%%EOF/.exec(source);
    if (!match?.[1]) throw new Error("Missing controlled xref offset");
    expect(Number(match[1])).toBe(source.indexOf("xref\n"));
    expect(doc.context.enumerateIndirectObjects()).toHaveLength(3);
  });

  for (const compressed of [false,true]) test(`accepts ${compressed ? "compressed object streams" : "classic objects"} and a passive HTTPS link without executing it`, async () => {
    const bytes = await passiveLinkPdf(compressed), doc = await PDFDocument.load(bytes,strictPdfLoad);
    expect(doc.getPageCount()).toBe(1); expect(doc.getTitle()).toBe(pdfFixtureTitle);
    const annotation = doc.getPage(0).node.lookup(PDFName.of("Annots"),PDFArray).lookup(0,PDFDict);
    const action = annotation.lookup(PDFName.of("A"),PDFDict);
    expect(action.lookup(PDFName.of("S"),PDFName).decodeText()).toBe("URI");
    expect(action.lookup(PDFName.of("URI"),PDFString).decodeText()).toBe(passiveUri);
    expect(objectStreams(doc).length > 0).toBe(compressed);
    await expect(validatePdfBytes(bytes,pdfLimits)).resolves.toEqual(accepted);
  });

  test("applies inclusive byte/page caps to actual valid documents rather than production tuning", async () => {
    const bytes = await savePdf(await newPdf(2)), doc = await PDFDocument.load(bytes,strictPdfLoad);
    expect(doc.getPageCount()).toBe(2);
    await expect(validatePdfBytes(bytes,{...pdfLimits,maxBytes:bytes.byteLength,maxPages:2})).resolves.toEqual(accepted);
    await expect(validatePdfBytes(bytes,{...pdfLimits,maxBytes:bytes.byteLength-1})).resolves.toEqual(rejected("resource-limit"));
    await expect(validatePdfBytes(bytes,{...pdfLimits,maxPages:1})).resolves.toEqual(rejected("resource-limit"));
  });

  test("counts direct AST containers, not only the small indirect-object table, against an explicit inspection budget", async () => {
    const baseline = await savePdf(await newPdf());
    await expect(validatePdfBytes(baseline,{...pdfLimits,maxObjects:128})).resolves.toEqual(accepted);
    const fixture = await graphPdf("many-direct"), doc = await PDFDocument.load(fixture.bytes,strictPdfLoad);
    const values = dictionary(doc.context.lookup(fixture.witness)).lookup(PDFName.of("Value"),PDFArray);
    expect(values.size()).toBe(160); expect(doc.context.enumerateIndirectObjects().length).toBeLessThan(128);
    expect(values.lookup(0,PDFDict).lookup(PDFName.of("Index"),PDFNumber).asNumber()).toBe(0);
    expect(values.lookup(159,PDFDict).lookup(PDFName.of("Index"),PDFNumber).asNumber()).toBe(159);
    await expect(validatePdfBytes(fixture.bytes,pdfLimits)).resolves.toEqual(accepted);
    await expect(validatePdfBytes(fixture.bytes,{...pdfLimits,maxObjects:128})).resolves.toEqual(rejected("resource-limit"));
  });

  test("bounds nested direct arrays and allows ordinary page-parent and metadata reference cycles without endless traversal", async () => {
    await expect(validatePdfBytes(classicPdf(),{...pdfLimits,maxDepth:12})).resolves.toEqual(accepted);
    const deep = await graphPdf("deep"), loaded = await PDFDocument.load(deep.bytes,strictPdfLoad);
    let value: PDFObject | undefined = dictionary(loaded.context.lookup(deep.witness)).get(PDFName.of("Value"));
    for (let depth = 0; depth < 24; depth++) {
      if (!(value instanceof PDFArray)) throw new Error("Controlled nested array did not survive serialization");
      expect(value.size()).toBe(1); value = value.get(0);
    }
    expect(value instanceof PDFString ? value.decodeText() : null).toBe("test-owned-deep-leaf");
    await expect(validatePdfBytes(deep.bytes,pdfLimits)).resolves.toEqual(accepted);
    await expect(validatePdfBytes(deep.bytes,{...pdfLimits,maxDepth:12})).resolves.toEqual(rejected("resource-limit"));
    const cycle = await graphPdf("reference-cycle"), doc = await PDFDocument.load(cycle.bytes,strictPdfLoad);
    const left = dictionary(doc.context.lookup(cycle.witness));
    expect(left.lookup(PDFName.of("Next"),PDFDict).get(PDFName.of("Back"))).toBe(cycle.witness);
    expect(doc.getPageCount()).toBe(1);
    await expect(validatePdfBytes(cycle.bytes,{...pdfLimits,maxObjects:128,maxDepth:12})).resolves.toEqual(accepted);
  });

  for (const userPassword of ["test-owned-user-password",""]) test(`rejects genuine AES-256 encryption with ${userPassword ? "a required user password" : "an empty user password and owner restrictions"}`, async () => {
    const bytes = await encryptedPdf(userPassword);
    const encrypted = await PDFDocument.load(bytes,{...strictPdfLoad,ignoreEncryption:true});
    expect(encrypted.isEncrypted).toBe(true); expect(encrypted.context.trailerInfo.Info).toBeUndefined();
    const encryptionRef = encrypted.context.trailerInfo.Encrypt;
    if (!(encryptionRef instanceof PDFRef)) throw new Error("Missing controlled encryption dictionary reference");
    expectStringFreeEncryptionGraph(encrypted,encryptionRef);
    const security = dictionary(encrypted.context.lookup(encryptionRef));
    expect(security.lookup(PDFName.of("Filter"),PDFName).decodeText()).toBe("Standard");
    expect(security.lookup(PDFName.of("V"),PDFNumber).asNumber()).toBe(5);
    expect(security.lookup(PDFName.of("R"),PDFNumber).asNumber()).toBe(6);
    expect(security.lookup(PDFName.of("P"),PDFNumber).asNumber() & 0x14).toBe(0); // Print/copy permission bits are unset.
    expect(security.lookup(PDFName.of("CF"),PDFDict).lookup(PDFName.of("StdCF"),PDFDict)
      .lookup(PDFName.of("CFM"),PDFName).decodeText()).toBe("AESV3");
    expect(security.lookup(PDFName.of("StrF"),PDFName).decodeText()).toBe("StdCF");
    expect(security.lookup(PDFName.of("StmF"),PDFName).decodeText()).toBe("StdCF");
    expect(encrypted.getPageCount()).toBe(1); expect(encrypted.getPage(0).getSize()).toEqual({width:16,height:16});
    const ciphertext = rawStream(encrypted.getPage(0).node.lookup(PDFName.of("Contents")));
    expect(ciphertext.dict.lookup(PDFName.of("Filter"),PDFName).decodeText()).toBe("FlateDecode");
    expect(ciphertext.dict.lookup(PDFName.of("Length"),PDFNumber).asNumber()).toBe(ciphertext.getContents().byteLength);
    expect(ciphertext.getContents()).not.toEqual(encryptedPdfContent);
    expect(ciphertext.getContents().byteLength % 16).toBe(0);

    // Exact content recovery and authentication, not a cleartext page count or an isEncrypted flag, prove the fixture.
    await expect(PDFDocument.load(bytes,{...strictPdfLoad,password:"test-owned-wrong-password"})).rejects.toThrow("Password incorrect");
    const decrypted = await PDFDocument.load(bytes,{...strictPdfLoad,password:userPassword});
    expect(decrypted.getPageCount()).toBe(1); expect(decrypted.getPage(0).getSize()).toEqual({width:16,height:16});
    expect(decrypted.context.trailerInfo.Info).toBeUndefined();
    expect(decrypted.isEncrypted).toBe(false); // Supplying '' also decrypts, so the core must not supply a password.
    const recovered = rawStream(decrypted.getPage(0).node.lookup(PDFName.of("Contents")));
    expect(recovered.dict.lookup(PDFName.of("Filter"),PDFName).decodeText()).toBe("FlateDecode");
    expect(ciphertext.getContents()).not.toEqual(recovered.getContents());
    expect(ciphertext.getContents().byteLength).toBeGreaterThan(recovered.getContents().byteLength);
    const decodedPlaintext = decodePDFRawStream(recovered).decode();
    const recoveredPlaintext: Uint8Array<ArrayBuffer> = new Uint8Array(decodedPlaintext.byteLength);
    recoveredPlaintext.set(decodedPlaintext);
    const expectedPlaintext: Uint8Array<ArrayBuffer> = new Uint8Array(encryptedPdfContent.byteLength);
    expectedPlaintext.set(encryptedPdfContent);
    expect(recoveredPlaintext).toEqual(expectedPlaintext);
    await expect(PDFDocument.load(bytes,strictPdfLoad)).rejects.toThrow("encrypted");
    await expect(validatePdfBytes(bytes,pdfLimits)).resolves.toEqual(rejected("encrypted-pdf"));
  });

  test("rejects a dangling trailer Encrypt reference even when Cantoo reports unencrypted", async () => {
    const bytes = await danglingEncryptionPdf(), source = ascii(bytes), doc = await PDFDocument.load(bytes,strictPdfLoad);
    const security = doc.context.trailerInfo.Encrypt;
    if (!(security instanceof PDFRef)) throw new Error("Controlled dangling Encrypt reference did not survive serialization");
    expect(security).toBe(PDFRef.of(65000)); expect(doc.context.lookup(security)).toBeUndefined();
    expect(doc.isEncrypted).toBe(false);
    expect(doc.getPageCount()).toBe(1); expect(doc.getPage(0).getSize()).toEqual({width:16,height:16});
    expect(doc.context.enumerateIndirectObjects()).toHaveLength(3);
    const offset = /startxref\n(\d+)\n%%EOF/.exec(source);
    if (!offset?.[1]) throw new Error("Missing controlled classic xref offset");
    expect(Number(offset[1])).toBe(source.indexOf("xref\n"));
    await expect(validatePdfBytes(bytes,pdfLimits)).resolves.toEqual(rejected("invalid-media"));
  });

  const actions: readonly { readonly kind: "JavaScript" | "Launch"; readonly placement: ActionPlacement; readonly compressed: boolean }[] = [
    {kind:"JavaScript",placement:"direct",compressed:false},
    {kind:"Launch",placement:"direct",compressed:false},
    {kind:"JavaScript",placement:"chained",compressed:true},
    {kind:"JavaScript",placement:"nested",compressed:true},
    {kind:"JavaScript",placement:"unreachable",compressed:true},
    {kind:"JavaScript",placement:"stream-dictionary",compressed:false},
  ];
  for (const {kind,placement,compressed} of actions) test(`rejects ${placement} ${kind} in ${compressed ? "compressed" : "classic"} objects after a valid round trip`, async () => {
    const fixture = await actionPdf(kind,placement,compressed), doc = await PDFDocument.load(fixture.bytes,strictPdfLoad);
    expect(doc.getPageCount()).toBe(1);
    const action = actionWitness(doc,fixture.witness,placement);
    expect(action.lookup(PDFName.of("S"),PDFName).decodeText()).toBe(kind);
    expect(action.lookup(PDFName.of(kind === "JavaScript" ? "JS" : "F"),PDFString).decodeText()).toContain("test-owned");
    if (placement === "chained") {
      if (!fixture.holder) throw new Error("Missing controlled Next-chain holder");
      const holder = dictionary(doc.context.lookup(fixture.holder));
      expect(holder.lookup(PDFName.of("S"),PDFName).decodeText()).toBe("URI");
      expect(holder.lookup(PDFName.of("Next"),PDFArray).get(0)).toBe(fixture.witness);
    }
    if (compressed) {
      const streams = objectStreams(doc); expect(streams.length).toBeGreaterThan(0);
      expect(ascii(fixture.bytes)).not.toContain("/JavaScript");
      expect(streams.map(stream => ascii(decodePDFRawStream(stream).decode())).some(body => body.includes("/JavaScript"))).toBe(true);
    }
    await expect(validatePdfBytes(fixture.bytes,pdfLimits)).resolves.toEqual(rejected("unsafe-pdf"));
  });

  for (const mode of ["type-only","ef-only"] as const) test(`rejects ${mode} embedded-file structures even without the other embedding marker`, async () => {
    const fixture = await embeddedPdf(mode,true), doc = await PDFDocument.load(fixture.bytes,strictPdfLoad);
    expect(doc.getPageCount()).toBe(1);
    const payload = rawStream(doc.context.lookup(fixture.payload));
    expect(ascii(payload.getContents())).toBe("test-owned-embedded-payload");
    if (mode === "type-only") {
      expect(payload.dict.lookup(PDFName.of("Type"),PDFName).decodeText()).toBe("EmbeddedFile");
      expect(doc.catalog.has(PDFName.of("FixtureFilespec"))).toBe(false);
    } else {
      expect(payload.dict.has(PDFName.of("Type"))).toBe(false);
      const file = dictionary(doc.context.lookup(fixture.witness));
      expect(file.lookup(PDFName.of("Type"),PDFName).decodeText()).toBe("Filespec");
      expect(file.lookup(PDFName.of("EF"),PDFDict).get(PDFName.of("F"))).toBe(fixture.payload);
      expect(objectStreams(doc).length).toBeGreaterThan(0);
    }
    await expect(validatePdfBytes(fixture.bytes,pdfLimits)).resolves.toEqual(rejected("unsafe-pdf"));
  });

  test("rejects an XFA executable container without asking a form engine to interpret it", async () => {
    const fixture = await xfaPdf(), doc = await PDFDocument.load(fixture.bytes,strictPdfLoad);
    expect(doc.getPageCount()).toBe(1);
    const form = dictionary(doc.context.lookup(fixture.form));
    expect(form.get(PDFName.of("XFA"))).toBe(fixture.payload);
    expect(ascii(rawStream(doc.context.lookup(fixture.payload)).getContents())).toContain("test-owned-xfa");
    await expect(validatePdfBytes(fixture.bytes,pdfLimits)).resolves.toEqual(rejected("unsafe-pdf"));
  });

  test("inspects decoded escaped action names and keys that are actually escaped in serialized PDF syntax", async () => {
    const bytes = escapedActionPdf(), source = ascii(bytes), doc = await PDFDocument.load(bytes,strictPdfLoad);
    expect(source).toContain("/Java#53cript"); expect(source).toContain("/#4aS");
    expect(source).not.toContain("/JavaScript"); expect(source).not.toContain("/JS");
    expect(doc.getPageCount()).toBe(1);
    const action = dictionary(doc.context.lookup(PDFRef.of(4)));
    expect(action.lookup(PDFName.of("S"),PDFName).decodeText()).toBe("JavaScript");
    expect(action.keys().map(key => key.decodeText())).toContain("JS");
    expect(action.lookup(PDFName.of("JS"),PDFString).decodeText()).toBe("test-owned-escaped-script");
    await expect(validatePdfBytes(bytes,pdfLimits)).resolves.toEqual(rejected("unsafe-pdf"));
  });

  test("inspects escaped EF and EmbeddedFile names after parser decoding rather than raw text matching", async () => {
    const bytes = escapedEmbeddedPdf(), source = ascii(bytes), doc = await PDFDocument.load(bytes,strictPdfLoad);
    expect(source).toContain("/E#46"); expect(source).toContain("/E#6dbeddedFile"); expect(source).not.toContain("/EmbeddedFile");
    expect(doc.getPageCount()).toBe(1);
    const file = dictionary(doc.context.lookup(PDFRef.of(4))), payload = rawStream(doc.context.lookup(PDFRef.of(5)));
    expect(file.keys().map(key => key.decodeText())).toContain("EF");
    expect(file.lookup(PDFName.of("EF"),PDFDict).get(PDFName.of("F"))).toBe(PDFRef.of(5));
    expect(payload.dict.lookup(PDFName.of("Type"),PDFName).decodeText()).toBe("EmbeddedFile");
    await expect(validatePdfBytes(bytes,pdfLimits)).resolves.toEqual(rejected("unsafe-pdf"));
  });

  test("rejects an unresolved reference in inspected non-page data instead of treating it as absent", async () => {
    const fixture = await graphPdf("dangling"), doc = await PDFDocument.load(fixture.bytes,strictPdfLoad);
    expect(doc.getPageCount()).toBe(1);
    const value = dictionary(doc.context.lookup(fixture.witness)).get(PDFName.of("Value"));
    expect(value).toBe(PDFRef.of(65000)); expect(doc.context.lookup(value)).toBeUndefined();
    await expect(validatePdfBytes(fixture.bytes,pdfLimits)).resolves.toEqual(rejected("invalid-media"));
  });

  for (const kind of ["unresolved","cycle","duplicate","count-mismatch"] as const) test(`rejects a ${kind} page graph without unbounded library page traversal`, async () => {
    const fixture = await badPagePdf(kind), doc = await PDFDocument.load(fixture.bytes,strictPdfLoad);
    // Do not call getPageCount/getPages on these intentionally invalid graphs in the unbounded test parent.
    const tree = dictionary(doc.context.lookup(fixture.tree)), kids = tree.lookup(PDFName.of("Kids"),PDFArray);
    if (kind === "unresolved") { expect(kids.get(0)).toBe(PDFRef.of(65000)); expect(doc.context.lookup(kids.get(0))).toBeUndefined(); }
    if (kind === "cycle") expect(kids.get(0)).toBe(fixture.tree);
    if (kind === "duplicate") { expect(kids.size()).toBe(2); expect(kids.get(0)).toBe(kids.get(1)); }
    if (kind === "count-mismatch") { expect(kids.size()).toBe(1); expect(tree.lookup(PDFName.of("Count"),PDFNumber).asNumber()).toBe(2); }
    await expect(validatePdfBytes(fixture.bytes,pdfLimits)).resolves.toEqual(rejected("invalid-media"));
  });

  test("allows a bounded benign xref-offset repair only when the inspected structure is still valid", async () => {
    const bytes = classicPdf(classicPageObjects,true), source = ascii(bytes), doc = await PDFDocument.load(bytes,strictPdfLoad);
    expect(source).toContain("startxref\n0\n%%EOF"); expect(source.indexOf("xref\n")).toBeGreaterThan(0);
    expect(doc.getPageCount()).toBe(1); expect(doc.getPage(0).getSize()).toEqual({width:16,height:16});
    await expect(validatePdfBytes(bytes,pdfLimits)).resolves.toEqual(accepted);
  });

  test("rejects invalid framing and object syntax with sanitized result codes, not raw parser exceptions", async () => {
    const malformed = [
      new Uint8Array(), text("%PDF-1.7\n%%EOF\n"),
      classicPdf([...classicPageObjects,"<< /Fixture (private-fixture-sentinel >>"]),
      text("%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages [private-fixture-sentinel"),
    ];
    for (const bytes of malformed) await expect(validatePdfBytes(bytes,pdfLimits)).resolves.toEqual(rejected("invalid-media"));
    for (const bytes of [text("<html>private-fixture-sentinel</html>"),Uint8Array.of(0x50,0x4b,3,4)]) {
      await expect(validatePdfBytes(bytes,pdfLimits)).resolves.toEqual(rejected("unsupported-format"));
    }
  });

  test("uses the exact immutable byte view and rejects invalid explicit inspection budgets", async () => {
    const bytes = classicPdf(), wrapped = new Uint8Array(bytes.length+4); wrapped.set(bytes,2);
    const before = new Uint8Array(wrapped);
    await expect(validatePdfBytes(wrapped.subarray(2,bytes.length+2),{...pdfLimits,maxBytes:bytes.length})).resolves.toEqual(accepted);
    expect(wrapped).toEqual(before);
    const invalid: readonly Partial<PdfValidationLimits>[] = [
      {maxBytes:0},{maxPages:0},{maxObjects:-1},{maxDepth:1.5},{maxPages:Number.NaN},{maxDepth:Number.POSITIVE_INFINITY},
    ];
    for (const limit of invalid) await expect(validatePdfBytes(bytes,{...pdfLimits,...limit})).resolves.toEqual(rejected("invalid-limits"));
    expect(wrapped).toEqual(before);
  });
});

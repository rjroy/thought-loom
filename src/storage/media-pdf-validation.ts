import { EncryptedPDFError, PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFInvalidObject,
  PDFName, PDFNull, PDFNumber, PDFRef, PDFStream, PDFString, type PDFContext, type PDFObject } from "@cantoo/pdf-lib";

export interface PdfValidationLimits {
  readonly maxBytes: number;
  readonly maxPages: number;
  /** Bounded AST inspection, including direct containers and reference traversal, not only indirect objects. */
  readonly maxObjects: number;
  readonly maxDepth: number;
}
export type PdfRejectionCode = "invalid-limits" | "unsupported-format" | "invalid-media" | "resource-limit" | "encrypted-pdf" | "unsafe-pdf";
export type PdfValidationResult = { readonly ok: true; readonly mimeType: "application/pdf" } |
  { readonly ok: false; readonly code: PdfRejectionCode };

class PdfPolicyFailure extends Error {
  constructor(readonly code: PdfRejectionCode) { super("PDF validation refused"); }
}
function refuse(code: PdfRejectionCode): never { throw new PdfPolicyFailure(code); }
function checkedLimits(input: PdfValidationLimits): PdfValidationLimits | null {
  if (typeof input !== "object" || input === null) return null;
  const {maxBytes,maxPages,maxObjects,maxDepth} = input;
  if (![maxBytes,maxPages,maxObjects,maxDepth].every(value => Number.isSafeInteger(value) && value > 0)) return null;
  return Object.freeze({maxBytes,maxPages,maxObjects,maxDepth});
}
const signature = [0x25,0x50,0x44,0x46,0x2d] as const;
const endMarker = [0x25,0x25,0x45,0x4f,0x46] as const;
const pdfWhitespace = new Set([0,9,10,12,13,32]);
function hasEndMarker(bytes: Uint8Array): boolean {
  let end = bytes.length;
  while (end > 0 && pdfWhitespace.has(bytes[end-1] ?? -1)) end--;
  return end >= endMarker.length && endMarker.every((byte,index) => bytes[end-endMarker.length+index] === byte);
}

// These are semantic PDF names, after the maintained parser has decoded escapes and object streams.
const executableKeys = new Set(["JS","JavaScript","EF","EmbeddedFiles","XFA","RichMediaContent","RichMediaSettings"]);
const executableActions = new Set(["JavaScript","Launch","GoToR","GoToE","SubmitForm","ImportData","ResetForm",
  "Rendition","Movie","Sound","GoTo3DView","RichMediaExecute"]);
const executableContainers = new Set(["EmbeddedFile","RichMedia","Movie","Sound","Screen","3D"]);
interface Work { readonly value: PDFObject; readonly depth: number }
interface PageFrame {
  readonly node: PDFDict;
  readonly kids: PDFArray;
  readonly declared: number;
  readonly depth: number;
  next: number;
  actual: number;
}

/** Post-parse work budgets do not constrain allocations already performed by the PDF parser. */
class PdfInspection {
  private inspections = 0;
  private readonly visited = new Set<PDFObject>();
  constructor(private readonly context: PDFContext, private readonly limits: PdfValidationLimits) {}

  private take(depth: number): void {
    if (depth > this.limits.maxDepth || ++this.inspections > this.limits.maxObjects) refuse("resource-limit");
  }
  private validRef(ref: PDFRef): void {
    if (!Number.isSafeInteger(ref.objectNumber) || ref.objectNumber < 1 ||
      !Number.isSafeInteger(ref.generationNumber) || ref.generationNumber < 0 || ref.generationNumber > 65535) refuse("invalid-media");
  }
  private resolved(input: PDFObject | undefined, depth: number): Work {
    if (input === undefined) refuse("invalid-media");
    if (!(input instanceof PDFRef)) return {value:input,depth};
    let value: PDFObject = input;
    const chain = new Set<PDFRef>();
    while (value instanceof PDFRef) {
      this.take(depth++); this.validRef(value);
      if (chain.has(value)) refuse("invalid-media");
      chain.add(value);
      const next = this.context.lookup(value);
      if (next === undefined) refuse("invalid-media");
      value = next;
    }
    return {value,depth};
  }
  private resolve(input: PDFObject | undefined, depth = 0): PDFObject { return this.resolved(input,depth).value; }
  private dictionary(input: PDFObject | undefined, depth = 0): PDFDict {
    const value = this.resolve(input,depth);
    if (!(value instanceof PDFDict)) refuse("invalid-media");
    return value;
  }
  private name(dict: PDFDict, key: string, depth = 0): string | undefined {
    const input = dict.get(PDFName.of(key));
    if (input === undefined) return undefined;
    const value = this.resolve(input,depth);
    return value instanceof PDFName ? value.decodeText() : undefined;
  }
  private enqueue(pending: Work[], value: PDFObject, depth: number): void {
    // Do not allocate an unbounded traversal queue before the object budget can be enforced.
    if (pending.length >= this.limits.maxObjects-this.inspections) refuse("resource-limit");
    pending.push({value,depth});
  }
  private inspectDictionary(dict: PDFDict, depth: number): void {
    const type = this.name(dict,"Type",depth+1), subtype = this.name(dict,"Subtype",depth+1);
    if ((type && executableContainers.has(type)) || (subtype && executableContainers.has(subtype))) refuse("unsafe-pdf");
    const action = this.name(dict,"S",depth+1);
    if (action && executableActions.has(action)) refuse("unsafe-pdf");
    if (type === "Action" && action !== "URI" && action !== "GoTo") refuse("unsafe-pdf");
    if (action === "URI") {
      const uri = this.resolve(dict.get(PDFName.of("URI")),depth+1);
      if (!(uri instanceof PDFString) && !(uri instanceof PDFHexString)) refuse("invalid-media");
      let target: URL;
      try { target = new URL(uri.decodeText()); } catch { refuse("unsafe-pdf"); }
      if (target.protocol !== "https:" && target.protocol !== "http:") refuse("unsafe-pdf");
    }
    if (action === "GoTo") {
      const destination = this.resolve(dict.get(PDFName.of("D")),depth+1);
      if (!(destination instanceof PDFArray) && !(destination instanceof PDFName) &&
        !(destination instanceof PDFString) && !(destination instanceof PDFHexString)) refuse("invalid-media");
    }
  }
  private walk(input: PDFObject): void {
    const pending: Work[] = [{value:input,depth:0}];
    while (pending.length) {
      const work = pending.pop(); if (!work) break;
      const {value,depth} = this.resolved(work.value,work.depth);
      this.take(depth);
      if (this.visited.has(value)) continue;
      this.visited.add(value);
      if (value instanceof PDFInvalidObject) refuse("invalid-media");
      if (value instanceof PDFStream) this.enqueue(pending,value.dict,depth+1);
      else if (value instanceof PDFDict) {
        this.inspectDictionary(value,depth);
        for (const [key,child] of value.entries()) {
          if (executableKeys.has(key.decodeText())) refuse("unsafe-pdf");
          this.enqueue(pending,key,depth+1); this.enqueue(pending,child,depth+1);
        }
      } else if (value instanceof PDFArray) {
        for (let index = value.size()-1; index >= 0; index--) this.enqueue(pending,value.get(index),depth+1);
      } else if (value instanceof PDFNumber) {
        if (!Number.isFinite(value.asNumber())) refuse("invalid-media");
      } else if (!(value instanceof PDFBool) && !(value instanceof PDFName) && !(value instanceof PDFString) &&
        !(value instanceof PDFHexString) && value !== PDFNull) refuse("invalid-media");
    }
  }

  private pageFrame(node: PDFDict, depth: number): PageFrame {
    this.take(depth);
    if (this.name(node,"Type",depth+1) !== "Pages") refuse("invalid-media");
    const kids = this.resolve(node.get(PDFName.of("Kids")),depth+1);
    const count = this.resolve(node.get(PDFName.of("Count")),depth+1);
    if (!(kids instanceof PDFArray) || !(count instanceof PDFNumber)) refuse("invalid-media");
    const declared = count.asNumber();
    if (!Number.isSafeInteger(declared) || declared < 0) refuse("invalid-media");
    if (declared > this.limits.maxPages) refuse("resource-limit");
    return {node,kids,declared,depth,next:0,actual:0};
  }
  private inspectPages(catalog: PDFDict): void {
    const root = this.dictionary(catalog.get(PDFName.of("Pages")));
    if (root.get(PDFName.of("Parent")) !== undefined) refuse("invalid-media");
    const seen = new Set<PDFDict>([root]), stack = [this.pageFrame(root,0)];
    let pageCount = 0;
    // Never call Cantoo's recursive page-cache traversal on an unvalidated page tree.
    while (stack.length) {
      const frame = stack.at(-1); if (!frame) break;
      if (frame.next === frame.kids.size()) {
        if (frame.actual !== frame.declared) refuse("invalid-media");
        stack.pop();
        const parent = stack.at(-1);
        if (parent) {
          if (frame.actual > this.limits.maxPages-parent.actual) refuse("resource-limit");
          parent.actual += frame.actual;
        }
        continue;
      }
      const node = this.dictionary(frame.kids.get(frame.next++),frame.depth+1);
      this.take(frame.depth+1);
      if (seen.has(node)) refuse("invalid-media");
      seen.add(node);
      if (this.dictionary(node.get(PDFName.of("Parent")),frame.depth+1) !== frame.node) refuse("invalid-media");
      const type = this.name(node,"Type",frame.depth+1);
      if (type === "Pages") stack.push(this.pageFrame(node,frame.depth+1));
      else if (type === "Page") {
        if (++pageCount > this.limits.maxPages) refuse("resource-limit");
        frame.actual++;
      } else refuse("invalid-media");
    }
    if (pageCount === 0) refuse("invalid-media");
  }

  inspect(): void {
    const objects = this.context.enumerateIndirectObjects();
    if (objects.length > this.limits.maxObjects) refuse("resource-limit");
    const catalog = this.dictionary(this.context.trailerInfo.Root);
    if (this.name(catalog,"Type") !== "Catalog") refuse("invalid-media");
    this.walk(catalog);
    for (const [ref,value] of objects) { this.validRef(ref); this.walk(value); }
    // An unencrypted vendor flag does not prove that the trailer's security reference resolves.
    for (const value of [this.context.trailerInfo.Info,this.context.trailerInfo.ID,
      this.context.trailerInfo.Size,this.context.trailerInfo.Encrypt]) {
      if (value !== undefined) this.walk(value);
    }
    this.inspectPages(catalog);
  }
}

/** Worker-only structural validation. Parsing must run under the separate process resource bounds before admission. */
export async function validatePdfBytes(bytes: Uint8Array, limits: PdfValidationLimits): Promise<PdfValidationResult> {
  try {
    const checked = checkedLimits(limits);
    if (!checked) return {ok:false,code:"invalid-limits"};
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return {ok:false,code:"invalid-media"};
    if (bytes.byteLength > checked.maxBytes) return {ok:false,code:"resource-limit"};
    const source = new Uint8Array(bytes);
    if (!signature.every((byte,index) => source[index] === byte)) return {ok:false,code:"unsupported-format"};
    if (!hasEndMarker(source)) return {ok:false,code:"invalid-media"};
    // No password, including ''. Empty-user-password owner restrictions must still be rejected.
    const doc = await PDFDocument.load(source,{throwOnInvalidObject:true,updateMetadata:false,ignoreEncryption:false,preserveXFA:true});
    if (doc.isEncrypted) return {ok:false,code:"encrypted-pdf"};
    new PdfInspection(doc.context,checked).inspect();
    return {ok:true,mimeType:"application/pdf"};
  } catch (error) {
    if (error instanceof EncryptedPDFError) return {ok:false,code:"encrypted-pdf"};
    return {ok:false,code:error instanceof PdfPolicyFailure ? error.code : "invalid-media"};
  }
}

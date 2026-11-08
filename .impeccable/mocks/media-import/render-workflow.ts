import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { readdir, access } from "node:fs/promises";

const directory = dirname(import.meta.path), root = resolve(directory,"../../..");
const { chromium } = await import(Bun.resolveSync("@playwright/test",resolve(root,"apps/web")));
const browser = await chromium.launch({executablePath:"/usr/bin/chromium",headless:true});
const cases = [
  ["source","ready"],["source","image"],["source","failed"],["source","retry-unknown"],
  ["source","rejected"],["source","unavailable"],["source","rejected-child"],["source","title"],
  ["source","download-error"],["upload","uncertain"],["statuses","ready"],["admission-states","ready"],
  ["interpretation","ready"],["interpretation","rejected"],["explore","ready"],["evolve","ready"],["ask","ready"],["export","ready"],
] as const;
const observations: unknown[] = [], failures: string[] = [];
const screenshots: {file:string;width:number;height:number;sha256:string}[]=[];
const destination = (view:string,state:string) => `${pathToFileURL(resolve(directory,"workflow.html"))}?view=${view}&state=${state}`;
type Page = Awaited<ReturnType<typeof browser.newPage>>;
async function layout(page:Page) {
  return page.evaluate(()=>{
    const visible=(element:HTMLElement)=>element.getClientRects().length>0&&!element.closest("[hidden]");
    const controls=[...document.querySelectorAll<HTMLElement>("button,input,textarea,select,summary,.back,.wordmark,.nav a,.text-action,.button")].filter(visible);
    const minHeight=(element:HTMLElement)=>element.matches('input[type="checkbox"],input[type="radio"]') ? element.closest("label")!.getBoundingClientRect().height : element.getBoundingClientRect().height;
    return {title:document.querySelector("h1")?.textContent,width:innerWidth,documentWidth:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,fontLoaded:document.fonts.check('18px "Source Sans 3"'),headings:document.querySelectorAll("h1").length,smallTargets:controls.filter(element=>minHeight(element)<43.9).map(element=>element.textContent?.trim()||element.id),unlabelledInputs:[...document.querySelectorAll<HTMLInputElement>("input,textarea,select")].filter(visible).filter(element=>!element.labels?.length&&!element.getAttribute("aria-label")).map(element=>element.id)};
  });
}
function checkLayout(result:Awaited<ReturnType<typeof layout>>,width:number,label:string) {
  if(result.documentWidth>width||!result.fontLoaded||result.headings!==1||result.smallTargets.length||result.unlabelledInputs.length)failures.push(`${label}: ${JSON.stringify(result)}`);
}
async function capture(page:Page,file:string) {
  await page.screenshot({path:resolve(directory,file),fullPage:true});
  const bytes=Buffer.from(await Bun.file(resolve(directory,file)).arrayBuffer());
  screenshots.push({file,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),sha256:createHash("sha256").update(bytes).digest("hex")});
}
try {
  for (const [size,width,height] of [["desktop",1440,900],["phone",390,844]] as const) {
    const page = await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
    const errors:string[]=[],requests:string[]=[];
    page.on("pageerror",error=>errors.push(error.message));
    page.on("request",request=>{if(!request.url().startsWith("file:"))requests.push(request.url());});
    for (const [view,state] of cases) {
      await page.goto(destination(view,state));
      await page.evaluate(()=>document.fonts.ready);
      if (state === "title") {
        await page.getByRole("button",{name:"Edit title",exact:true}).click();
      }
      await capture(page,`next-${view}-${state}-${size}.png`);
      const result = await layout(page);
      checkLayout(result,width,`${view}/${state}/${size}`);
      if((view==="source"&&["rejected","rejected-child"].includes(state))||(view==="interpretation"&&state==="rejected")){
        const text=await page.locator(".notice").innerText();
        if(!text.includes("Rejected content is unavailable to AI.")||text.includes("not ordinary AI context"))failures.push(`${view}/${state}/${size}: ambiguous rejection copy`);
      }
      observations.push({view,state,size,...result});
    }
    // Keyboard and disclosure checks over the design simulations, not the production client.
    await page.goto(destination("source","ready"));
    await page.getByRole("button",{name:"About",exact:true}).focus();
    await page.keyboard.press("Enter");
    if(!await page.locator("#metadata").isVisible())failures.push(`${size}: About did not open`);
    await page.getByRole("button",{name:"Full reply",exact:true}).click();
    if(!await page.locator("#full-reply").isVisible())failures.push(`${size}: Full reply did not open`);
    await page.locator(".source-tools summary").click();
    await page.keyboard.press("Escape");
    if(await page.locator(".source-tools details").getAttribute("open")!==null)failures.push(`${size}: More actions failed Escape`);
    if(!await page.locator(".source-tools summary").evaluate(element=>element===document.activeElement))failures.push(`${size}: More actions focus did not return`);
    await page.getByRole("button",{name:"Edit title",exact:true}).click();
    if(!await page.locator("#source-title").evaluate(element=>element===document.activeElement))failures.push(`${size}: Title field did not receive focus`);
    await page.getByRole("button",{name:"Cancel",exact:true}).click();
    if(!await page.getByRole("button",{name:"Edit title",exact:true}).evaluate(element=>element===document.activeElement))failures.push(`${size}: Title cancel focus did not return`);
    await page.goto(destination("source","retry-unknown"));
    await page.getByRole("button",{name:"Check current processing",exact:true}).click();
    if(!(await page.locator(".source-status [data-feedback]").innerText()).includes("read the current source"))failures.push(`${size}: Check incorrectly modelled`);
    await page.getByRole("button",{name:"Send same retry request",exact:true}).click();
    if(!(await page.locator(".source-status [data-feedback]").innerText()).includes("not a read-only Check"))failures.push(`${size}: Retry resend write not disclosed`);
    await page.goto(destination("source","rejected"));
    if(!await page.getByRole("button",{name:"Evolve this idea"}).isDisabled())failures.push(`${size}: Rejected source can Evolve`);
    if(await page.getByRole("button",{name:"Try interpretation again"}).count())failures.push(`${size}: Rejected source has retry`);
    await page.goto(destination("source","hidden"));
    if(await page.getByRole("button",{name:"Try interpretation again"}).count())failures.push(`${size}: Existing interpretation has retry`);
    await page.goto(destination("source","rejected-child"));
    if(await page.getByRole("link",{name:"Inspect recorded context",exact:true}).count())failures.push(`${size}: History contains a self-inspection link`);
    await page.getByRole("link",{name:"Open idea",exact:true}).click();
    if(!await page.getByRole("button",{name:"Evolve this idea"}).isDisabled())failures.push(`${size}: Rejected child lost inspection scope`);
    await page.goto(destination("upload","uncertain"));
    if(await page.locator("#upload-clarification").getAttribute("readonly")===null)failures.push(`${size}: Unknown upload snapshot editable`);
    await page.getByRole("button",{name:"Check upload",exact:true}).click();
    if(!(await page.locator("[data-feedback]").innerText()).includes("does not send the file again"))failures.push(`${size}: Upload Check incorrectly modelled`);
    if(size==="phone"){
      await page.goto(destination("explore","ready"));
      await page.getByRole("button",{name:"Filters",exact:true}).click();
      if(!await page.locator("#filters").isVisible())failures.push("phone: Filters did not open");
      await page.keyboard.press("Escape");
      if(await page.locator("#filters").isVisible())failures.push("phone: Filters failed Escape");
      await page.goto(destination("evolve","ready"));
      await page.locator("[data-context]").click();
      if(await page.locator("#starting-context").isVisible())failures.push("phone: starting context did not close");
      await page.locator("[data-context]").click();
      await page.locator("#contribution").focus();await page.keyboard.press("Tab");
      if(!await page.getByRole("button",{name:"Send",exact:true}).evaluate(element=>element===document.activeElement))failures.push("phone: contribution did not lead to inline Send");
    }
    if(errors.length||requests.length)failures.push(`${size}: ${JSON.stringify({errors,requests})}`);
    observations.push({size,interactions:"About/Full reply/More actions Escape/focus; title focus and Cancel; read versus write recovery wording; rejected/interpretation-exists retry guards; readonly upload snapshot; narrow filter/context disclosure and inline Send checked.",externalRequests:requests,pageErrors:errors});
    await page.goto(`${pathToFileURL(resolve(directory,"comp.html"))}?state=entry`);
    await page.evaluate(()=>document.fonts.ready);
    await capture(page,`b-entry-current-${size}.png`);
    const captureLayout=await layout(page);checkLayout(captureLayout,width,`Capture/${size}`);
    const canopy=await page.locator(".capture-canopy").isVisible();
    if(canopy!==(size==="desktop"))failures.push(`${size}: Capture canopy breakpoint differs from incumbent`);
    const importCount=await page.getByRole("button",{name:"Import",exact:true}).count();
    if(importCount!==1)failures.push(`${size}: Capture does not have exactly one Import button`);
    await page.locator("#thought").fill("A controlled draft stays while choosing the import type.");
    await page.getByRole("button",{name:"Import",exact:true}).click();
    await page.getByRole("button",{name:"Import",exact:true}).click();
    await page.keyboard.press("Escape");
    if(await page.locator("#import-trigger").getAttribute("aria-expanded")!=="false"||await page.locator("#thought").inputValue()!=="A controlled draft stays while choosing the import type.")failures.push(`${size}: chooser changed the Capture draft or failed Escape`);
    if(!await page.locator("#import-trigger").evaluate(element=>element===document.activeElement))failures.push(`${size}: chooser focus did not return`);
    observations.push({size,currentCapture:{...captureLayout,canopyVisible:canopy,oneImportButton:importCount===1,chooser:"Toggle/Escape/focus return and visible draft retention checked",scope:"Approved canopy only on desktop Capture. No unused alternatives retained."}});
    for(const importState of ["selected","queued"]){
      await page.goto(`${pathToFileURL(resolve(directory,"comp.html"))}?state=${importState}`);
      await page.evaluate(()=>document.fonts.ready);
      await capture(page,`b-${importState}-${size}.png`);
      const result=await layout(page);checkLayout(result,width,`B/${importState}/${size}`);
      observations.push({size,view:"import",state:importState,...result});
    }
    await page.goto(`${pathToFileURL(resolve(directory,"comp.html"))}?state=selected`);
    await page.locator("#clarification").focus();await page.keyboard.press("Tab");
    if(!await page.getByRole("button",{name:"Import file",exact:true}).evaluate(element=>element===document.activeElement))failures.push(`${size}: clarification did not lead to Import file`);
    await page.keyboard.press("Enter");await page.waitForURL("**state=queued");
    if(!await page.getByRole("heading",{name:"Original saved",exact:true}).isVisible())failures.push(`${size}: explicit mock admission did not show original receipt`);
    if(errors.length||requests.length)failures.push(`${size}: import simulation ${JSON.stringify({errors,requests})}`);
    await page.close();
  }
  const review=await browser.newPage({viewport:{width:1440,height:900}});
  await review.goto(pathToFileURL(resolve(directory,"review.html")).href);
  const board=await review.evaluate(()=>({images:document.images.length,imagesLoaded:[...document.images].every(image=>image.complete&&image.naturalWidth>0),overflow:document.documentElement.scrollWidth>innerWidth}));
  if(!board.imagesLoaded||board.overflow)failures.push(`Review board: ${JSON.stringify(board)}`);
  const refs=await review.evaluate(()=>[...document.querySelectorAll<HTMLAnchorElement|HTMLImageElement|HTMLScriptElement|HTMLLinkElement>("a[href],img[src],script[src],link[href]")].map(element=>element instanceof HTMLImageElement||element instanceof HTMLScriptElement?element.src:(element as HTMLAnchorElement).href));
  const localFiles=[...new Set(refs.filter(value=>value.startsWith("file:")).map(value=>decodeURIComponent(new URL(value).pathname)))];
  for(const file of localFiles){try{await access(file);}catch{failures.push(`Dangling review reference: ${file}`);}}
  const narrowReview=await browser.newPage({viewport:{width:390,height:844}});await narrowReview.goto(pathToFileURL(resolve(directory,"review.html")).href);
  if(await narrowReview.evaluate(()=>document.documentElement.scrollWidth>innerWidth))failures.push("Narrow review index overflows");
  await narrowReview.close();await review.close();
  const sources:Record<string,string>={};
  for(const file of ["comp.html","comp.css","comp.js","workflow.html","workflow.css","workflow.js","review.html","workflow-contract.json","decisions.json","render-workflow.ts"])sources[file]=createHash("sha256").update(new Uint8Array(await Bun.file(resolve(directory,file)).arrayBuffer())).digest("hex");
  const luminance=(hex:string)=>{const rgb=hex.match(/../g)!.map(value=>parseInt(value,16)/255).map(value=>value<=.04045 ? value/12.92 : ((value+.055)/1.055)**2.4);return rgb[0]!* .2126+rgb[1]!* .7152+rgb[2]!* .0722;};
  const contrast=[['body/ground','d5d3c5','031315'],['muted/card','a5a8a0','122224'],['placeholder/input','a5a8a0','0e1e20'],['link/card','65c4c5','122224'],['user/ground','83b88a','031315'],['primary text/gold','031315','efb83f']].map(([role,foreground,background])=>{const a=luminance(foreground!),b=luminance(background!);return {role,ratio:Number(((Math.max(a,b)+.05)/(Math.min(a,b)+.05)).toFixed(2))};});
  if(contrast.some(pair=>pair.ratio<4.5))failures.push("A checked text contrast pair is below 4.5:1");
  const retainedFiles=(await readdir(directory)).sort();
  if(retainedFiles.some(file=>/^([ac]-|b-entry-(desktop|phone)\.png$)/.test(file)))failures.push("Unused or superseded screenshots remain");
  const expectedScreenshots=screenshots.map(item=>item.file).sort();
  if(JSON.stringify(retainedFiles.filter(file=>file.endsWith(".png")))!==JSON.stringify(expectedScreenshots))failures.push("Retained PNG set differs from reproducible selected screenshots");
  await Bun.write(resolve(directory,"workflow-render-evidence.json"),JSON.stringify({capturedAt:new Date().toISOString(),browser:await browser.version(),boundary:"Standalone file:// HTML/CSS. No production client, Hono, operator service, provider or personal data used.",commands:["node --check .impeccable/mocks/media-import/comp.js","node --check .impeccable/mocks/media-import/workflow.js","bun --no-env-file .impeccable/mocks/media-import/render-workflow.ts"],sources,screenshots,contrast,observations,reviewBoard:{...board,localReferencesChecked:localFiles.length},retainedFiles,failures},null,2)+"\n");
} finally {await browser.close();}
if(failures.length)throw new Error(failures.join("\n"));
console.log(`Rendered ${screenshots.length} selected desktop/narrow screenshots; checked layout, labels, targets, rejection copy, keyboard/recovery controls and review links. Evidence: workflow-render-evidence.json`);

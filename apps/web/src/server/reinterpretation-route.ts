import "server-only";
import { callDaemon } from "./client";
import { readWebConfig } from "./config";
import { isTrustedRequest } from "./request-guard";
import { handleReinterpretation } from "./reinterpretation";

/** Shared wrapper for the two fixed Idea routes; browser headers never become daemon credentials. */
export async function reinterpretationRoute(request: Request, params: Promise<{id:string;key?:string}>, method: "POST" | "GET"): Promise<Response> {
  try {
    const config = readWebConfig({THOUGHTLOOM_WEB_ORIGIN:process.env.THOUGHTLOOM_WEB_ORIGIN});
    if (!isTrustedRequest(config,request)) throw new Error("Forbidden");
    const {id,key} = await params;
    return await handleReinterpretation(request,id,method === "POST" ? request.headers.get("idempotency-key") : key ?? null,{callDaemon});
  } catch {
    return Response.json({message:"Forbidden."},{status:403,headers:{"cache-control":"private, no-store"}});
  }
}

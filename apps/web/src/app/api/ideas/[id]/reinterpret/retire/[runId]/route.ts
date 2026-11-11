import { interpretationRetirementRoute } from "../../../../../../../server/reinterpretation-route";

export function GET(request:Request, context:{params:Promise<{id:string;runId:string}>}):Promise<Response> {
  return interpretationRetirementRoute(request,context.params);
}

export function POST(request:Request, context:{params:Promise<{id:string;runId:string}>}):Promise<Response> {
  return interpretationRetirementRoute(request,context.params);
}

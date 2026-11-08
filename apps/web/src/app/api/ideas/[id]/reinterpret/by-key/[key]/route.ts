import { reinterpretationRoute } from "../../../../../../../server/reinterpretation-route";

export function GET(request: Request, context: {params: Promise<{id:string;key:string}>}): Promise<Response> {
  return reinterpretationRoute(request,context.params,"GET");
}

import { reinterpretationRoute } from "../../../../../server/reinterpretation-route";

export function POST(request: Request, context: {params: Promise<{id:string}>}): Promise<Response> {
  return reinterpretationRoute(request,context.params,"POST");
}

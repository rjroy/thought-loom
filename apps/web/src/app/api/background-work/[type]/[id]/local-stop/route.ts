import { backgroundRoute } from "../../../../../../features/background-work/server";
export function POST(request:Request,context:{params:Promise<{type:string;id:string}>}):Promise<Response> {
  return backgroundRoute(request,"stop",context.params);
}

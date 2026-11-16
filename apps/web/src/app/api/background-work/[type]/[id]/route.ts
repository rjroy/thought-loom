import { backgroundRoute } from "../../../../../features/background-work/server";
export function GET(request:Request,context:{params:Promise<{type:string;id:string}>}):Promise<Response> {
  return backgroundRoute(request,"detail",context.params);
}

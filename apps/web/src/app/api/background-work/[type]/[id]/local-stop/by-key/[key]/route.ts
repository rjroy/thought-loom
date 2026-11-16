import { backgroundRoute } from "../../../../../../../../features/background-work/server";
export function GET(request:Request,context:{params:Promise<{type:string;id:string;key:string}>}):Promise<Response> {
  return backgroundRoute(request,"receipt",context.params);
}

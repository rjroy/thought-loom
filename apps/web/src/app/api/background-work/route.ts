import { backgroundRoute } from "../../../features/background-work/server";
export function GET(request:Request):Promise<Response> { return backgroundRoute(request,"list"); }

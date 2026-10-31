import { privateJSON } from "../../../../../lib/daemon";
import { developmentCommand } from "../../../../../lib/development-server";
export async function POST(request: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await params;
  if (action !== "reject" && action !== "restore") return privateJSON({ error: "Action not found" }, 404);
  return developmentCommand(request, action === "reject" ? "reject-relationship" : "restore-relationship", id);
}

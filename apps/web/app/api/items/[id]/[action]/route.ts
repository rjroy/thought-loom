import { privateJSON } from "../../../../../lib/daemon";
import { developmentCommand } from "../../../../../lib/development-server";
export async function POST(request: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await params;
  if (action !== "correct" && action !== "restore") return privateJSON({ error: "Action not found" }, 404);
  return developmentCommand(request, action === "correct" ? "correct-item" : "restore-item", id);
}

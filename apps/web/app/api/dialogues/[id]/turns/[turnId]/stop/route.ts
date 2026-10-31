import { developmentCommand } from "../../../../../../../lib/development-server";
export async function POST(request: Request, { params }: { params: Promise<{ id: string; turnId: string }> }) {
  const { id, turnId } = await params; return developmentCommand(request, "stop", id, turnId);
}

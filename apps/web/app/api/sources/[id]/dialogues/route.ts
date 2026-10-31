import { developmentCommand } from "../../../../../lib/development-server";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return developmentCommand(request, "create", (await params).id);
}

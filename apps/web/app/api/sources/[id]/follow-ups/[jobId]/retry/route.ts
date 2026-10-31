import { retryFollowUp } from "../../../../../../../lib/follow-up-server";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; jobId: string }> }) {
  const { id, jobId } = await params;
  return retryFollowUp(request, id, jobId);
}

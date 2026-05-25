import { NextRequest } from "next/server";
import { cancelConversation, getConversation } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/conversations/:id -> full transcript (resume)
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const data = await getConversation(params.id);
  if (!data) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(data);
}

// DELETE /api/conversations/:id -> cancel (soft; transcript is kept)
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  await cancelConversation(params.id);
  return Response.json({ ok: true });
}

import { NextRequest } from "next/server";
import { createConversation, listConversations } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/conversations -> list (for the sidebar)
export async function GET() {
  const conversations = await listConversations();
  return Response.json({ conversations });
}

// POST /api/conversations -> create a fresh one
export async function POST(_req: NextRequest) {
  const conversation = await createConversation();
  return Response.json({ conversation }, { status: 201 });
}

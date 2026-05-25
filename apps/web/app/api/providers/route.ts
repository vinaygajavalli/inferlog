import { listProviders } from "@/lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/providers -> { providers: [{name, model}], default } for the UI selector
export async function GET() {
  return Response.json(listProviders());
}

import { corsHeaders } from "../_shared/cors.ts";
import { createReportAsrHandler } from "../_shared/direct_asr.ts";

const handler = createReportAsrHandler();
Deno.serve(async (req) => {
  const response = await handler(req);
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
});

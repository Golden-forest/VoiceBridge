// Direct ASR is retired: clients must upload WAV to /transcribe so that the
// server verifies audio duration and settles provider usage. Keeping these
// routes as tombstones also stops older installed clients from obtaining keys
// or changing usage via a fabricated result report.
import { jsonResponse } from "./cors.ts";

function retiredHandler() {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok");
    if (req.method !== "POST") {
      return jsonResponse({ ok: false, code: "method_not_allowed", message: "仅支持 POST 请求。" }, 405);
    }
    return jsonResponse({
      ok: false,
      code: "direct_asr_retired",
      message: "请更新客户端，使用可信云端音频识别接口。"
    }, 410);
  };
}

export function createIssueAsrHandler() { return retiredHandler(); }
export function createReportAsrHandler() { return retiredHandler(); }

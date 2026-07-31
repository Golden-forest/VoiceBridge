import test from "node:test";
import assert from "node:assert/strict";

import { transcribeCloudAudio, __clearAccessTokenCacheForTests } from "./cloudTranscribe.js";

test("transcribeCloudAudio posts audio to the Supabase Edge Function with auth headers", async () => {
  __clearAccessTokenCacheForTests();
  const calls = [];
  const supabase = createSupabaseClient({
    url: "https://project.supabase.co",
    anonKey: "anon-key",
    accessToken: "access-token"
  });

  const result = await transcribeCloudAudio({
    supabase,
    audio: new Blob(["wav"], { type: "audio/wav" }),
    filename: "voicebridge.wav",
    durationMs: 1234,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { ok: true, request_id: "req-1", text: "hello" });
    }
  });

  assert.deepEqual(result, { ok: true, request_id: "req-1", text: "hello" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://project.supabase.co/functions/v1/transcribe");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.apikey, "anon-key");
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-token");
  assert.equal(calls[0].options.body.get("duration_ms"), "1234");
  assert.equal(calls[0].options.body.get("audio").name, "voicebridge.wav");
});

test("transcribeCloudAudio throws the function error message for non-2xx JSON responses", async () => {
  __clearAccessTokenCacheForTests();
  const supabase = createSupabaseClient({
    url: "https://project.supabase.co",
    anonKey: "anon-key",
    accessToken: "access-token"
  });

  await assert.rejects(
    () => transcribeCloudAudio({
      supabase,
      audio: new Blob(["wav"], { type: "audio/wav" }),
      fetch: async () => jsonResponse(429, {
        ok: false,
        code: "quota_exceeded",
        message: "本月云端语音识别额度已用完。"
      })
    }),
    /本月云端语音识别额度已用完/
  );
});

test("transcribeCloudAudio requires a signed-in Supabase session", async () => {
  __clearAccessTokenCacheForTests();
  const supabase = createSupabaseClient({
    url: "https://project.supabase.co",
    anonKey: "anon-key",
    accessToken: ""
  });

  await assert.rejects(
    () => transcribeCloudAudio({
      supabase,
      audio: new Blob(["wav"], { type: "audio/wav" }),
      fetch: async () => {
        throw new Error("fetch should not be called");
      }
    }),
    /请先登录/
  );
});

function createSupabaseClient({ url, anonKey, accessToken }) {
  return {
    supabaseUrl: url,
    supabaseKey: anonKey,
    auth: {
      async getSession() {
        return {
          data: {
            session: accessToken ? { access_token: accessToken } : null
          },
          error: null
        };
      }
    }
  };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    }
  };
}

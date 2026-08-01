# Cloud ASR Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align cloud ASR with LAN version (filler removal, ASR params) and add per-plan recording duration limits (free=15s, pro=60s, admin=60s).

**Architecture:** Modify Edge Function to add filler post-processing and aligned ASR params. Add per-plan recording limits via shared PLAN_LIMITS. Delete admin fast path so all plans go through atomic RPC. New Supabase migration for millisecond-level duration checks.

**Tech Stack:** TypeScript (Deno Edge Functions), JavaScript (PWA frontend), PL/pgSQL (Supabase migration), node:test (testing)

---

## Pre-flight Checks

Before starting Task 1, verify the working tree is clean and on the expected branch:

- [ ] Run `git -C /Users/hl/Projects/VoiceBridge status` and confirm clean tree on branch `cloud-activation`
- [ ] Run `cd /Users/hl/Projects/VoiceBridge && node --test supabase/functions/_shared/tencent_asr.test.js` and capture the baseline (must pass before any change)
- [ ] Run `cd /Users/hl/Projects/VoiceBridge && node --test src/server/asr/transcriber.test.js` and capture the baseline (must pass before any change)

If either baseline test fails, STOP and surface the failure to the orchestrator before proceeding.

---

## Task 1: Tencent ASR Parameter Alignment

**Files:**
- `supabase/functions/_shared/tencent_asr.ts` (modify Flash params + add SentenceRecognition filter params)
- `supabase/functions/_shared/tencent_asr.test.js` (add parameter-assertion tests)

**Goal:** Bring the 4 Tencent filter parameters (`filter_dirty`, `filter_modal`, `filter_punc`, `convert_num_mode`) in line between FlashRecognition and SentenceRecognition. Flash switches `filter_modal` from `"0"` to `"1"`. SentenceRecognition gains all 4 filter params it currently lacks.

### Step 1.1 — Write failing tests for Flash params (RED)

- [ ] Open `supabase/functions/_shared/tencent_asr.test.js` and append the following block before the final newline. Place it after the existing second `test(...)` block.

```js
test("FlashRecognition aligns Tencent filter params (filter_modal=1, filter_punc=0, filter_dirty=0, convert_num_mode=1)", async () => {
  const request = await createTencentFlashRecognitionRequest({
    audioBytes: new Uint8Array([1, 2, 3]),
    config,
    timestamp: 1_700_000_000
  });
  const url = new URL(request.url);
  assert.equal(url.searchParams.get("filter_modal"), "1", "filter_modal must be 1");
  assert.equal(url.searchParams.get("filter_punc"), "0", "filter_punc must be 0");
  assert.equal(url.searchParams.get("filter_dirty"), "0", "filter_dirty must be 0");
  assert.equal(url.searchParams.get("convert_num_mode"), "1", "convert_num_mode must be 1");
});
```

- [ ] Run `cd /Users/hl/Projects/VoiceBridge && node --test supabase/functions/_shared/tencent_asr.test.js` and confirm the new test FAILS with `filter_modal` being `"0"` (this is the expected RED state).

### Step 1.2 — Flip Flash `filter_modal` to `"1"` (GREEN for Flash)

- [ ] Edit `supabase/functions/_shared/tencent_asr.ts`. In `createTencentFlashRecognitionRequest`, change the `params` object so `filter_modal: "0"` becomes `filter_modal: "1"`. The full params block becomes:

```ts
  const params = new URLSearchParams({
    convert_num_mode: "1",
    engine_type: config.engServiceType,
    filter_dirty: "0",
    filter_modal: "1",
    filter_punc: "0",
    first_channel_only: "1",
    secretid: config.secretId,
    speaker_diarization: "0",
    timestamp: String(timestamp),
    voice_format: "wav",
    word_info: "0"
  });
```

- [ ] Run `cd /Users/hl/Projects/VoiceBridge && node --test supabase/functions/_shared/tencent_asr.test.js` and confirm ALL Flash tests PASS (including the new one from Step 1.1).

### Step 1.3 — Write failing test for SentenceRecognition filter params (RED)

- [ ] Open `supabase/functions/_shared/tencent_asr.test.js` and update the import to also bring in `createTencentSentenceRecognitionRequest`:

```js
import {
  createTencentFlashRecognitionRequest,
  createTencentSentenceRecognitionRequest,
  transcribeTencentWav
} from "./tencent_asr.ts";
```

- [ ] Append this test after the Flash params test from Step 1.1:

```js
test("SentenceRecognition payload carries aligned Tencent filter params", async () => {
  const result = await createTencentSentenceRecognitionRequest({
    audioBase64: "AAAA",
    audioLength: 4,
    requestId: "req-1",
    config,
    timestamp: 1_700_000_000
  });
  assert.equal(result.payload.FilterDirty, 0);
  assert.equal(result.payload.FilterModal, 1);
  assert.equal(result.payload.FilterPunc, 0);
  assert.equal(result.payload.ConvertNumMode, 1);
});
```

- [ ] Run the test file and confirm the new test FAILS (the payload does not yet contain `FilterDirty` / `FilterModal` / `FilterPunc` / `ConvertNumMode`).

### Step 1.4 — Add the 4 filter params to SentenceRecognition payload (GREEN)

- [ ] Edit `supabase/functions/_shared/tencent_asr.ts`. In `createTencentSentenceRecognitionRequest`, replace the `payload` object literal with:

```ts
  const payload = {
    ProjectId: 0,
    SubServiceType: 2,
    EngSerViceType: config.engServiceType,
    SourceType: 1,
    VoiceFormat: "wav",
    UsrAudioKey: `voicebridge-${requestId}`,
    Data: audioBase64,
    DataLen: audioLength,
    FilterDirty: 0,
    FilterModal: 1,
    FilterPunc: 0,
    ConvertNumMode: 1
  };
```

- [ ] Run `cd /Users/hl/Projects/VoiceBridge && node --test supabase/functions/_shared/tencent_asr.test.js` and confirm ALL tests PASS.

- [ ] Commit:

```bash
git -C /Users/hl/Projects/VoiceBridge add supabase/functions/_shared/tencent_asr.ts supabase/functions/_shared/tencent_asr.test.js
git -C /Users/hl/Projects/VoiceBridge commit -m "feat(asr): align Tencent FlashRecognition and SentenceRecognition filter params"
```

---

## Task 2: Filler Post-processing + Contract Tests (Both Runtimes)

**Files:**
- `supabase/functions/_shared/tencent_asr.ts` (add + export `removeFillerWords`, apply on both return paths)
- `supabase/functions/_shared/tencent_asr.test.js` (10 fixture tests)
- `src/server/asr/transcriber.js` (replace regex with LEADING + TRAILING logic, mirror Edge)
- `src/server/asr/transcriber.test.js` (update fixtures to new contract)

**Goal:** Cloud ASR output is currently NOT filler-cleaned (the LAN path is). Cloud users hear "嗯你好" while LAN users hear "你好". Fix by porting the same `removeFillerWords` logic to the Edge Function and applying it on both Flash and SentenceRecognition return paths. Use the new LEADING + TRAILING regex pair (spec v3) on both runtimes, and replace the legacy single-char-class behavior on LAN.

The 10 canonical fixtures (must produce identical output on both runtimes):

| # | Input | Expected |
|---|---|---|
| 1 | `"嗯，你好"` | `"你好"` |
| 2 | `"你好嗯嗯嗯，世界"` | `"你好，世界"` |
| 3 | `"嗯嗯嗯你好"` | `"你好"` |
| 4 | `"你好，嗯嗯嗯，世界"` | `"你好，世界"` |
| 5 | `"哼唱"` | `"哼唱"` |
| 6 | `"啧啧称奇"` | `"啧啧称奇"` |
| 7 | `""` | `""` |
| 8 | `"你好世界"` | `"你好世界"` |
| 9 | `"嗯嗯嗯"` | `""` |
| 10 | `"你好，世界嗯嗯嗯"` | `"你好，世界"` |

### Step 2.1 — Add 10 RED fixtures for the Edge runtime

- [ ] Open `supabase/functions/_shared/tencent_asr.test.js`. Add `removeFillerWords` to the import list:

```js
import {
  createTencentFlashRecognitionRequest,
  createTencentSentenceRecognitionRequest,
  removeFillerWords,
  transcribeTencentWav
} from "./tencent_asr.ts";
```

- [ ] Append the parameterized fixture test at the end of the file:

```js
const FILLER_FIXTURES = [
  ["嗯，你好", "你好"],
  ["你好嗯嗯嗯，世界", "你好，世界"],
  ["嗯嗯嗯你好", "你好"],
  ["你好，嗯嗯嗯，世界", "你好，世界"],
  ["哼唱", "哼唱"],
  ["啧啧称奇", "啧啧称奇"],
  ["", ""],
  ["你好世界", "你好世界"],
  ["嗯嗯嗯", ""],
  ["你好，世界嗯嗯嗯", "你好，世界"]
];

for (const [input, expected] of FILLER_FIXTURES) {
  test(`removeFillerWords(${JSON.stringify(input)}) => ${JSON.stringify(expected)}`, () => {
    assert.equal(removeFillerWords(input), expected);
  });
}
```

- [ ] Run `cd /Users/hl/Projects/VoiceBridge && node --test supabase/functions/_shared/tencent_asr.test.js` and confirm the 10 new tests FAIL (function not exported yet).

### Step 2.2 — Implement `removeFillerWords` on the Edge runtime (GREEN for unit)

- [ ] Edit `supabase/functions/_shared/tencent_asr.ts`. Add the following block immediately after the `ACTION` constant declaration near the top of the file (after line 5, before the `TencentAsrConfig` type):

```ts
const FILLER_LEADING = /(^|[\s，,。.!！？?、；;：:])(嗯+|呃+|唔+|噢+|欸+|诶+|哼+|嘖+|啧+)/gu;
const FILLER_TRAILING = /(嗯+|呃+|唔+|噢+|欸+|诶+|哼+|嘖+|啧+)([\s，,。.!！？?、；;：:]|$)/gu;

export function removeFillerWords(text: string): string {
  if (!text) return text;
  return text
    .replace(FILLER_LEADING, "$1")
    .replace(FILLER_TRAILING, "$2")
    .replace(/([，,。.!！？?、；;：:])\1+/gu, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([，,。.!！？?、；;：:])/gu, "$1")
    .replace(/^[\s，,。.!！？?、；;：:]+/u, "")
    .trim() || "";
}
```

- [ ] Run the Edge test file and confirm the 10 fixture tests PASS.

### Step 2.3 — Apply `removeFillerWords` on both return paths

- [ ] Edit `supabase/functions/_shared/tencent_asr.ts`. Locate the Flash success return inside `transcribeTencentWav` (the line that currently reads `return text;` after the `console.info("Tencent ASR provider: FlashRecognition")` line). Replace that single line with:

```ts
      console.info("Tencent ASR provider: FlashRecognition");
      return removeFillerWords(text);
```

- [ ] In the same function, locate the SentenceRecognition success return (the line `return result.trim();` near the end). Replace it with:

```ts
  return removeFillerWords(result.trim());
```

- [ ] Append a contract test that verifies both Flash and SentenceRecognition paths apply filler removal. Add to `tencent_asr.test.js`:

```js
test("FlashRecognition path applies removeFillerWords on its returned text", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        code: 0,
        flash_result: [{ text: "嗯，你好嗯嗯嗯，世界" }]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  const text = await transcribeTencentWav({
    audioBytes: new Uint8Array([1, 2, 3]),
    requestId: "req-flash",
    config,
    fetchImpl
  });
  assert.equal(text, "你好，世界");
});

test("SentenceRecognition fallback path applies removeFillerWords on its returned text", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ code: 4003, message: "service not enabled" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(
      JSON.stringify({ Response: { Result: "嗯嗯嗯你好，世界嗯嗯嗯" } }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const text = await transcribeTencentWav({
    audioBytes: new Uint8Array([1, 2, 3]),
    requestId: "req-sentence",
    config,
    fetchImpl
  });
  assert.equal(text, "你好，世界");
});
```

- [ ] Run `cd /Users/hl/Projects/VoiceBridge && node --test supabase/functions/_shared/tencent_asr.test.js` and confirm ALL tests PASS.

### Step 2.4 — Update LAN `removeFillerWords` to the new LEADING + TRAILING contract

The LAN version currently uses a single char-class regex (`/[嗯呃唔噢欸诶哼嘖啧]/g`) which deletes filler characters even inside multi-character words like "哼唱". The new LEADING + TRAILING pair only strips filler runs that sit at punctuation/word boundaries. Some existing LAN tests encode the old behavior and must be updated to the new contract.

- [ ] Open `src/server/asr/transcriber.js`. Replace the existing filler regex + function block (the lines containing `FILLER_CHARS`, `FILLER_RE`, and the `removeFillerWords` function body) with:

```js
// 独立语气词清理（与 Edge Function supabase/functions/_shared/tencent_asr.ts 共用同一份契约）。
// 仅删除出现在边界（句首/句末/标点两侧）的语气词串，保留多字词中的同字符（如"哼唱"、"啧啧称奇"）。
const FILLER_LEADING = /(^|[\s，,。.!！？?、；;：:])(嗯+|呃+|唔+|噢+|欸+|诶+|哼+|嘖+|啧+)/gu;
const FILLER_TRAILING = /(嗯+|呃+|唔+|噢+|欸+|诶+|哼+|嘖+|啧+)([\s，,。.!！？?、；;：:]|$)/gu;

/**
 * 清理独立语气词（嗯/呃/唔等）。
 * 与 Edge Function 端的 removeFillerWords 保持字节级一致。
 */
function removeFillerWords(text) {
  if (!text) return text;
  return text
    .replace(FILLER_LEADING, "$1")
    .replace(FILLER_TRAILING, "$2")
    .replace(/([，,。.!！？?、；;：:])\1+/gu, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([，,。.!！？?、；;：:])/gu, "$1")
    .replace(/^[\s，,。.!！？?、；;：:]+/u, "")
    .trim() || "";
}
```

- [ ] Open `src/server/asr/transcriber.test.js`. The existing tests in this file encode the OLD single-char-class contract. Two cases must change:
  - `"嗯，你好"` previously expected `"，你好"`; new contract expects `"你好"`.
  - `"我说嗯然后"` previously expected `"我说然后"`; under the new LEADING+TRAILING regex there is no boundary before/after `嗯`, so it is preserved: `"我说嗯然后"`.

  Replace the entire block of the first six filler tests with the following canonical fixture set so both runtimes share one contract:

```js
const FILLER_FIXTURES = [
  ["嗯，你好", "你好"],
  ["你好嗯嗯嗯，世界", "你好，世界"],
  ["嗯嗯嗯你好", "你好"],
  ["你好，嗯嗯嗯，世界", "你好，世界"],
  ["哼唱", "哼唱"],
  ["啧啧称奇", "啧啧称奇"],
  ["", ""],
  ["你好世界", "你好世界"],
  ["嗯嗯嗯", ""],
  ["你好，世界嗯嗯嗯", "你好，世界"]
];

for (const [input, expected] of FILLER_FIXTURES) {
  test(`removeFillerWords(${JSON.stringify(input)}) => ${JSON.stringify(expected)}`, () => {
    assert.equal(removeFillerWords(input), expected);
  });
}

test("returns null/undefined for null/undefined input", () => {
  assert.equal(removeFillerWords(null), null);
  assert.equal(removeFillerWords(undefined), undefined);
});
```

- [ ] Run `cd /Users/hl/Projects/VoiceBridge && node --test src/server/asr/transcriber.test.js` and confirm ALL tests PASS.

### Step 2.5 — Commit

- [ ] Stage and commit:

```bash
git -C /Users/hl/Projects/VoiceBridge add supabase/functions/_shared/tencent_asr.ts supabase/functions/_shared/tencent_asr.test.js src/server/asr/transcriber.js src/server/asr/transcriber.test.js
git -C /Users/hl/Projects/VoiceBridge commit -m "feat(asr): port removeFillerWords to Edge and align both runtimes to LEADING+TRAILING contract"
```

---

## Task 3: Delete Admin Fast Path

**Files:**
- `supabase/functions/transcribe/index.ts` (remove `isAdminFastPath` branch, unify usage finalization, read `max_audio_ms`)

**Goal:** Today when `cachedPlan === "admin"` the function skips `reserve_and_get_plan` entirely and inserts usage via `recordUsage` (a plain `INSERT`, no quota check). This creates a TOCTOU gap and divergent code paths. Collapse the two paths so every request goes through the atomic RPC. Also switch the success-path finalizer from `void updateReservedUsage(...).catch(...)` to `EdgeRuntime.waitUntil(...)` so errors are observable, and rename the field read from `max_audio_seconds` to `max_audio_ms` (Task 4 will rename the SQL column to match).

### Step 3.1 — Remove the `isAdminFastPath` variable and branch

- [ ] Edit `supabase/functions/transcribe/index.ts`. In the top-of-handler declarations (around the line `let usageReserved = false;`), delete the line:

```ts
  let isAdminFastPath = false;
```

- [ ] Replace the entire reservation block (currently starting at `const cachedPlan = getCachedPlan(userId);` and ending at `usageReserved = true; }`) with this unified block that always calls the RPC:

```ts
    const cachedPlan = getCachedPlan(userId);

    const reservation = await reserveAndGetPlan(serviceClient, {
      userId,
      requestId,
      durationMs,
      audioSizeBytes,
      cachedPlan
    });
    planCache.set(userId, {
      plan: reservation.plan,
      expiresAt: Date.now() + PLAN_CACHE_TTL_MS
    });
    const reservationError = reservation.errorCode;
    if (reservationError) {
      await recordUsage(serviceClient, { userId, requestId, durationMs, audioSizeBytes, status: "rejected", errorCode: reservationError });
      if (reservationError === "audio_too_long") {
        return errorResponse(
          reservationError,
          `单次录音最长支持 ${Math.ceil(reservation.maxAudioMs / 1000)} 秒。`,
          413
        );
      }
      const message = reservationError === ERROR_CODE_QUOTA_EXCEEDED
        ? "本月云端语音识别额度已用完。"
        : reservationError === "rate_limited"
          ? "请求过于频繁，请稍后再试。"
          : "云端语音识别请求已存在，请稍后再试。";
      return errorResponse(reservationError, message, 429);
    }
    usageReserved = true;
```

### Step 3.2 — Unify the success-path usage finalizer with `EdgeRuntime.waitUntil`

- [ ] Edit `supabase/functions/transcribe/index.ts`. Replace the post-`transcribeTencentWav` success finalization block (currently the `if (isAdminFastPath) { ... } else { ... }` block) with a single unified call:

```ts
    EdgeRuntime.waitUntil(updateReservedUsage(serviceClient, {
      userId,
      requestId,
      status: "success"
    }));
    return jsonResponse({ ok: true, request_id: requestId, text });
```

### Step 3.3 — Switch the `reserveAndGetPlan` field read from `max_audio_seconds` to `max_audio_ms`

- [ ] Edit `supabase/functions/transcribe/index.ts`. In the `reserveAndGetPlan` helper return object, rename the property and read the new SQL column. Replace the existing return block:

```ts
  return {
    plan,
    maxAudioSeconds: Number(data?.max_audio_seconds) || 60,
    errorCode: typeof data?.error_code === "string" ? data.error_code : null
  };
```

with:

```ts
  return {
    plan,
    maxAudioMs: Number(data?.max_audio_ms) || 60_000,
    errorCode: typeof data?.error_code === "string" ? data.error_code : null
  };
```

### Step 3.4 — Verify the static checks

There is no Edge entrypoint test harness in this repo (the `transcribe/index.ts` file references `Deno.serve` and `EdgeRuntime` which only exist in the Supabase runtime). Verification for this task is purely structural.

- [ ] Run `cd /Users/hl/Projects/VoiceBridge && grep -n "isAdminFastPath" supabase/functions/transcribe/index.ts` and confirm there are ZERO matches.
- [ ] Run `cd /Users/hl/Projects/VoiceBridge && grep -n "max_audio_seconds" supabase/functions/transcribe/index.ts` and confirm there are ZERO matches.
- [ ] Run `cd /Users/hl/Projects/VoiceBridge && grep -n "max_audio_ms" supabase/functions/transcribe/index.ts` and confirm at least one match.
- [ ] Run `cd /Users/hl/Projects/VoiceBridge && node --test supabase/functions/_shared/tencent_asr.test.js src/server/asr/transcriber.test.js` and confirm no test regressed (these tests do not touch `transcribe/index.ts` but provide a sanity check that nothing else broke).

### Step 3.5 — Commit

```bash
git -C /Users/hl/Projects/VoiceBridge add supabase/functions/transcribe/index.ts
git -C /Users/hl/Projects/VoiceBridge commit -m "refactor(transcribe): remove admin fast path and unify usage finalization via EdgeRuntime.waitUntil"
```

---

## Task 4: New Supabase Migration — Millisecond-Level Duration Checks

**Files:**
- `supabase/migrations/0015_align_cloud_asr_limits.sql` (NEW — do NOT modify `0011_admin_plan.sql`)

**Goal:** The current `reserve_and_get_plan` rounds duration to whole seconds (`ceil(ms/1000)`), which means a 15.6s free recording is billed as 16s and a 15.4s recording is accepted as 15s. The new per-plan hard caps (free=15s, pro=60s, admin=60s) require sub-second precision to be enforceable. Rewrite the function with millisecond-level math, return `max_audio_ms` instead of `max_audio_seconds`, and accumulate monthly usage in milliseconds.

Per spec v3: free=15000ms, pro=60000ms, admin=60000ms. The `max_audio_ms` field name aligns with the rename performed in Task 3.

### Step 4.1 — Write the new migration file

- [ ] Create the file `supabase/migrations/0015_align_cloud_asr_limits.sql` with the full content:

```sql
-- Align cloud ASR per-plan limits with LAN behavior and enforce millisecond-level
-- duration checks. Replaces the version defined in 0011_admin_plan.sql.
--
-- Changes vs 0011:
--   * per-request hard cap lowered: free=15s, pro=60s, admin=60s (was 60/60/3600).
--   * duration check now uses raw p_audio_duration_ms (no ceil-to-seconds).
--   * monthly usage accumulated in milliseconds (was sum-of-ceil-seconds).
--   * RPC returns max_audio_ms instead of max_audio_seconds.

create or replace function public.reserve_and_get_plan(
  p_user_id uuid,
  p_request_id uuid,
  p_provider text,
  p_mode text,
  p_audio_duration_ms int,
  p_audio_size_bytes int,
  p_cached_plan text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_plan text;
  v_is_admin boolean := false;
  v_monthly_ms bigint;
  v_max_audio_ms int;
  v_rate_limit_per_minute int;
  v_month_start timestamptz := date_trunc('month', now());
  v_used_ms bigint := 0;
  v_recent_count int := 0;
begin
  -- Resolve plan: trust cached plan only if not admin (admin status can change,
  -- so always re-check from DB to avoid privilege escalation via stale cache).
  if p_cached_plan in ('free', 'pro') then
    v_plan := p_cached_plan;
  else
    select case
      when status in ('active', 'trialing') and plan = 'pro' then 'pro'
      when plan = 'admin' then 'admin'
      else 'free'
    end
      into v_plan
      from public.subscriptions
      where user_id = p_user_id
      order by updated_at desc
      limit 1;
    v_plan := coalesce(v_plan, 'free');
  end if;

  -- Check admin flag from profiles (independent of subscription table).
  select coalesce(is_admin, false)
    into v_is_admin
    from public.profiles
    where user_id = p_user_id;

  if v_is_admin then
    v_plan := 'admin';
  end if;

  -- Limits (keep aligned with src/shared/planLimits.js and
  -- supabase/functions/_shared/plan_limits.ts).
  if v_plan = 'admin' then
    v_monthly_ms := 60000 * 1000000;  -- effectively unlimited (~277h)
    v_max_audio_ms := 60000;
    v_rate_limit_per_minute := 10000;
  elsif v_plan = 'pro' then
    v_monthly_ms := 18000 * 1000;
    v_max_audio_ms := 60000;
    v_rate_limit_per_minute := 30;
  else
    v_monthly_ms := 600 * 1000;
    v_max_audio_ms := 15000;
    v_rate_limit_per_minute := 10;
  end if;

  -- Hard cap: per-request duration limit, millisecond-precise.
  if p_audio_duration_ms > v_max_audio_ms then
    return jsonb_build_object(
      'plan', v_plan,
      'max_audio_ms', v_max_audio_ms,
      'error_code', 'audio_too_long'
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || to_char(v_month_start, 'YYYY-MM'), 0)
  );

  -- Monthly usage: sum raw milliseconds (no rounding).
  select coalesce(sum(audio_duration_ms), 0)
    into v_used_ms
    from public.usage_events
    where user_id = p_user_id
      and status in ('success', 'processing')
      and created_at >= v_month_start;

  if v_used_ms + p_audio_duration_ms > v_monthly_ms then
    return jsonb_build_object(
      'plan', v_plan,
      'max_audio_ms', v_max_audio_ms,
      'error_code', 'quota_exceeded'
    );
  end if;

  select count(*)::int
    into v_recent_count
    from public.usage_events
    where user_id = p_user_id
      and created_at >= now() - interval '1 minute';

  if v_recent_count >= v_rate_limit_per_minute then
    return jsonb_build_object(
      'plan', v_plan,
      'max_audio_ms', v_max_audio_ms,
      'error_code', 'rate_limited'
    );
  end if;

  insert into public.usage_events (
    user_id,
    request_id,
    provider,
    mode,
    audio_duration_ms,
    audio_size_bytes,
    status
  ) values (
    p_user_id,
    p_request_id,
    p_provider,
    p_mode,
    p_audio_duration_ms,
    p_audio_size_bytes,
    'processing'
  );

  return jsonb_build_object(
    'plan', v_plan,
    'max_audio_ms', v_max_audio_ms,
    'error_code', null
  );
exception
  when unique_violation then
    return jsonb_build_object(
      'plan', coalesce(v_plan, 'free'),
      'max_audio_ms', coalesce(v_max_audio_ms, 60000),
      'error_code', 'duplicate_request'
    );
end;
$$;

revoke execute on function public.reserve_and_get_plan(uuid, uuid, text, text, int, int, text)
  from public, anon, authenticated;
grant execute on function public.reserve_and_get_plan(uuid, uuid, text, text, int, int, text)
  to service_role;
```

### Step 4.2 — Update the TypeScript plan_limits mirror to match

- [ ] Edit `supabase/functions/_shared/plan_limits.ts`. Replace the entire `PLAN_LIMITS` object with the millisecond-and-second aligned version (note: `maxAudioSeconds` stays as a derived display value but we add `maxAudioMs`; the SQL migration is the source of truth for the RPC, and `src/shared/planLimits.js` is the source of truth for the frontend):

```ts
export const PLAN_LIMITS = Object.freeze({
  free: {
    monthlySeconds: 600,
    maxAudioSeconds: 15,
    maxAudioMs: 15_000,
    rateLimitPerMinute: 10
  },
  pro: {
    monthlySeconds: 18000,
    maxAudioSeconds: 60,
    maxAudioMs: 60_000,
    rateLimitPerMinute: 30
  },
  admin: {
    monthlySeconds: 1_000_000,
    maxAudioSeconds: 60,
    maxAudioMs: 60_000,
    rateLimitPerMinute: 10_000
  }
});

export type PlanName = keyof typeof PLAN_LIMITS;

export function getPlanLimit(plan: string | null | undefined) {
  return PLAN_LIMITS[(plan || "free") as PlanName] || PLAN_LIMITS.free;
}

export function isPaidStatus(status: string | null | undefined) {
  return status === "active" || status === "trialing";
}

export function isAdminPlan(plan: string | null | undefined) {
  return plan === "admin";
}
```

### Step 4.3 — Commit

- [ ] Stage and commit:

```bash
git -C /Users/hl/Projects/VoiceBridge add supabase/migrations/0015_align_cloud_asr_limits.sql supabase/functions/_shared/plan_limits.ts
git -C /Users/hl/Projects/VoiceBridge commit -m "feat(db): millisecond-level duration checks and aligned per-plan caps (free=15s, pro=60s, admin=60s)"
```

---

## Task 5: Frontend PLAN_LIMITS + Per-Plan Recording Duration

**Files:**
- `src/shared/planLimits.js` (the shared source — admin entry + free=15)
- `src/public/shared/planLimits.js` (exact mirror — verified by build gate in Task 6)
- `src/public/app.js` (delete inline `PLAN_LIMITS`, import shared, add `currentUserPlan`, dynamic record timer)
- `src/public/cloudRecorder.js` (accept `maxDurationMs`, sample-count auto-stop)
- `src/public/i18n/zh-CN.js` (reachedLimit becomes a function, add `maxDurationHint`)
- `src/public/i18n/en.js` (mirror)

**Goal:** Currently every cloud user gets a hard-coded 55-second record timer regardless of plan. After this task, free users stop at 15s, pro/admin at 60s, all driven by a single shared `PLAN_LIMITS` module. The frontend reads the user's plan from the existing `subscriptions` query and feeds the matching `maxAudioMs` into both the UI timer and the `cloudRecorder` sample-count guard. The 55-second constant in i18n also becomes plan-aware.

### Step 5.1 — Update the shared `planLimits.js`

- [ ] Edit `src/shared/planLimits.js`. Replace the entire contents with:

```js
export const PLAN_LIMITS = Object.freeze({
  free: {
    monthlySeconds: 600,
    maxAudioSeconds: 15,
    maxAudioMs: 15_000,
    rateLimitPerMinute: 10
  },
  pro: {
    monthlySeconds: 18000,
    maxAudioSeconds: 60,
    maxAudioMs: 60_000,
    rateLimitPerMinute: 30
  },
  admin: {
    monthlySeconds: 1_000_000,
    maxAudioSeconds: 60,
    maxAudioMs: 60_000,
    rateLimitPerMinute: 10_000
  }
});

export function getPlanLimit(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

export function isPaidStatus(status) {
  return status === "active" || status === "trialing";
}

export function isAdminPlan(plan) {
  return plan === "admin";
}
```

### Step 5.2 — Mirror the shared file into the public directory

The hosted build (`hosted-pwa/scripts/build-static.mjs`) enforces that `src/shared/planLimits.js` is byte-identical to `src/public/shared/planLimits.js`. Without the mirror the build gate fails.

- [ ] Open `src/public/shared/planLimits.js` (create if missing) and paste the EXACT same content as `src/shared/planLimits.js` from Step 5.1. The two files must be byte-identical (Task 6 will verify this in CI).

### Step 5.3 — Update i18n: `reachedLimit` becomes a function, add `maxDurationHint`

- [ ] Edit `src/public/i18n/zh-CN.js`. Replace the line:

```js
    reachedLimit: '已到 55 秒上限，正在上传音频...',
```

with:

```js
    reachedLimit: (seconds) => `已到 ${seconds} 秒上限，正在上传音频...`,
    maxDurationHint: (seconds) => `本次最多录制 ${seconds} 秒。`,
```

- [ ] Edit `src/public/i18n/en.js`. Replace the line:

```js
    reachedLimit: 'Reached the 55-second limit, uploading audio…',
```

with:

```js
    reachedLimit: (seconds) => `Reached the ${seconds}-second limit, uploading audio…`,
    maxDurationHint: (seconds) => `You can record up to ${seconds} seconds this time.`,
```

### Step 5.4 — Import shared PLAN_LIMITS in `app.js` and remove the inline copy

- [ ] Edit `src/public/app.js`. Add a new import line next to the existing `shared/protocol.js` import at the top (so the import block becomes):

```js
import { CloudRealtime, getPhoneDeviceId, isDesktopDeviceCandidate } from "./cloudRealtime.js";
import { createBillingSession } from "./billing.js";
import { recordWavUntilStopped } from "./cloudRecorder.js";
import { transcribeCloudAudio } from "./cloudTranscribe.js";
import { commandStore } from "./commandStore.js";
import { isProtocolCompatible } from "./shared/protocol.js";
import { PLAN_LIMITS, getPlanLimit, isAdminPlan } from "./shared/planLimits.js";
import { t, getAvailableLocales, setLocale, getCurrentLocale, getIntlLocale } from "./i18n/i18n.js";
```

- [ ] Still in `src/public/app.js`, delete the inline `PLAN_LIMITS` declaration near line 496 (the block `const PLAN_LIMITS = { free: ..., pro: ..., admin: ... };`). The import above replaces it.

- [ ] Also delete the local `isPaidStatus` helper declared near line 502 (it is now imported transitively via the shared module; if not imported, leave the local one — but per the import line above we did NOT import `isPaidStatus`, so KEEP the existing local `isPaidStatus` function as-is). Verify the file still parses.

### Step 5.5 — Capture the current user's plan as `currentUserPlan`

- [ ] Edit `src/public/app.js`. Near the top-level state declarations (the area where `isRecording`, `recordSeconds`, etc. are declared), add a new module-level variable. Find a sensible place (for example just above `function beginRecordingState()`) and add:

```js
let currentUserPlan = "free";  // updated by handleAuthState subscription query
```

- [ ] In `handleAuthState` (the block that currently queries `subscriptions` and updates `planBadge`), locate the `.then(({ data: sub }) => { ... })` callback. Insert a line that assigns `currentUserPlan` from the resolved plan. The block currently reads:

```js
      .then(({ data: sub }) => {
        const plan = sub?.plan === "admin"
          ? "admin"
          : (sub?.plan === "pro" && isPaidStatus(sub.status) ? "pro" : "free");
        if (plan === "admin") {
          planBadge.textContent = t('planBadge.admin');
          planBadge.classList.remove("pro");
          planBadge.classList.add("admin");
        } else {
          planBadge.textContent = plan === "pro" ? t('planBadge.pro') : t('planBadge.free');
          planBadge.classList.remove("admin");
          planBadge.classList.toggle("pro", plan === "pro");
        }
      })
```

Replace it with:

```js
      .then(({ data: sub }) => {
        const plan = sub?.plan === "admin"
          ? "admin"
          : (sub?.plan === "pro" && isPaidStatus(sub.status) ? "pro" : "free");
        currentUserPlan = plan;
        if (plan === "admin") {
          planBadge.textContent = t('planBadge.admin');
          planBadge.classList.remove("pro");
          planBadge.classList.add("admin");
        } else {
          planBadge.textContent = plan === "pro" ? t('planBadge.pro') : t('planBadge.free');
          planBadge.classList.remove("admin");
          planBadge.classList.toggle("pro", plan === "pro");
        }
      })
```

### Step 5.6 — Derive a `currentMaxAudioMs()` helper and use it in `beginRecordingState`

- [ ] Add a small helper just above `beginRecordingState`:

```js
function currentMaxAudioMs() {
  return getPlanLimit(currentUserPlan).maxAudioMs;
}
```

- [ ] Replace the entire `beginRecordingState` function body so the timeout uses the dynamic limit and the toast formats with the plan's max seconds:

```js
function beginRecordingState() {
  isRecording = true;
  recordSeconds = 0;
  recordingStartedAt = performance.now();
  currentRecordingDurationMs = null;
  recordButton.classList.add("recording");
  setRecordActive();
  setActionButtonsDisabled(true);
  setConnectionStatus(statusDot.className.includes("connected") ? "connected" : "connecting", t('record.recording'));

  const maxMs = currentMaxAudioMs();
  const maxSeconds = Math.floor(maxMs / 1000);
  maxRecordTimer = setTimeout(() => {
    if (isRecording) {
      void stopRecording().catch((error) => {
        console.error("Failed to stop recording:", error);
        showToast(error.message || t('record.recordingFailed'), true);
        finishUpload();
      });
      showToast(t('record.reachedLimit', maxSeconds));
    }
  }, maxMs - 500);  // stop 500ms before hard cap so the recorder doesn't overshoot

  timerInterval = setInterval(() => {
    recordSeconds++;
    const mins = String(Math.floor(recordSeconds / 60)).padStart(2, "0");
    const secs = String(recordSeconds % 60).padStart(2, "0");
    labelEl.textContent = `${mins}:${secs}`;
  }, 1000);
}
```

### Step 5.7 — Pass `maxDurationMs` into `recordWavUntilStopped` and wire auto-stop

- [ ] Edit `src/public/app.js`. In `startRecording`, the cloud branch currently calls `recordWavUntilStopped({ onStopReady })`. Pass the new sample-count guard:

```js
    if (isCloudMode) {
      const maxMs = currentMaxAudioMs();
      recorder = await recordWavUntilStopped({
        onStopReady: async (blob) => uploadAudio(blob, "wav"),
        maxDurationMs: maxMs,
        onMaxDurationReached: () => {
          void stopRecording().catch((error) => {
            console.error("Auto-stop failed:", error);
            finishUpload();
          });
        }
      });
      beginRecordingState();
      return;
    }
```

- [ ] Edit `src/public/cloudRecorder.js`. Replace the entire file with:

```js
import { encodeWav16Mono } from "./wavEncoder.js";

export async function recordWavUntilStopped({ onStopReady, maxDurationMs, onMaxDurationReached }) {
  let stream = null;
  let audioContext = null;
  let source = null;
  let processor = null;
  const chunks = [];
  let stopped = false;
  let totalSamples = 0;
  let autoStopTriggered = false;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    try {
      audioContext = new AudioContextCtor({ sampleRate: 16000 });
    } catch {
      audioContext = new AudioContextCtor();
    }
    source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      const channel = new Float32Array(event.inputBuffer.getChannelData(0));
      chunks.push(channel);
      totalSamples += channel.length;
      if (
        typeof maxDurationMs === "number" &&
        maxDurationMs > 0 &&
        !autoStopTriggered &&
        typeof onMaxDurationReached === "function" &&
        (totalSamples / audioContext.sampleRate) * 1000 >= maxDurationMs
      ) {
        autoStopTriggered = true;
        try {
          onMaxDurationReached();
        } catch (callbackError) {
          console.error("onMaxDurationReached threw:", callbackError);
        }
      }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
  } catch (error) {
    if (processor) processor.onaudioprocess = null;
    safeDisconnect(processor);
    safeDisconnect(source);
    safeStopTracks(stream);
    await safeCloseAudioContext(audioContext);
    throw error;
  }

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      processor.onaudioprocess = null;
      safeDisconnect(processor);
      safeDisconnect(source);
      safeStopTracks(stream);
      try {
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const samples = new Float32Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          samples.set(chunk, offset);
          offset += chunk.length;
        }
        const blob = encodeWav16Mono(samples, audioContext.sampleRate);
        await onStopReady(blob);
      } finally {
        await safeCloseAudioContext(audioContext);
      }
    }
  };
}

function safeDisconnect(node) {
  try {
    node?.disconnect();
  } catch {
    // Already disconnected or unavailable.
  }
}

function safeStopTracks(stream) {
  try {
    stream?.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // Ignore individual track cleanup failures.
      }
    });
  } catch {
    // Ignore malformed stream cleanup failures.
  }
}

async function safeCloseAudioContext(audioContext) {
  if (!audioContext || audioContext.state === "closed") return;
  try {
    await audioContext.close();
  } catch {
    // Cleanup best effort; preserve the primary recording error.
  }
}
```

### Step 5.8 — Manual sanity check (no automated test exists for `app.js`)

- [ ] Run `cd /Users/hl/Projects/VoiceBridge && node --check src/public/cloudRecorder.js` and confirm it parses.
- [ ] Run `cd /Users/hl/Projects/VoiceBridge && node --check src/public/i18n/zh-CN.js` and `node --check src/public/i18n/en.js`.
- [ ] Run `cd /Users/hl/Projects/VoiceBridge && grep -n "55_000\|55秒\|55-second" src/public/app.js src/public/i18n/*.js` and confirm ZERO matches (no stray references to the old hard-coded 55s).

### Step 5.9 — Commit

```bash
git -C /Users/hl/Projects/VoiceBridge add src/shared/planLimits.js src/public/shared/planLimits.js src/public/app.js src/public/cloudRecorder.js src/public/i18n/zh-CN.js src/public/i18n/en.js
git -C /Users/hl/Projects/VoiceBridge commit -m "feat(frontend): per-plan recording duration via shared PLAN_LIMITS and sample-count auto-stop"
```

---

## Task 6: Hosted Mirror Build Gate

**Files:**
- `hosted-pwa/scripts/build-static.mjs` (extend `verifyMirroredSources`)

**Goal:** The hosted PWA build already enforces that `src/public/shared/protocol.js` is byte-identical to `src/shared/protocol.js` and that `src/public/app.js` matches `src/public/app.js` with a `protocol.js` path rewrite. It also already lists `shared/planLimits.js` in `exactMirrors` — BUT it does NOT apply a path rewrite for `app.js`'s new `../shared/planLimits.js` import. After Task 5 the `app.js` source imports `./shared/planLimits.js` (relative within `src/public`), so the existing single-rewrite for `protocol.js` is sufficient. This task hardens the gate by making the rewrite rule generic for any `../shared/*` import so future shared modules are covered, and adds an explicit `cloudRecorder.js` cloud-source check.

### Step 6.1 — Generalize the `../shared/*` rewrite in `verifyMirroredSources`

- [ ] Edit `hosted-pwa/scripts/build-static.mjs`. Replace the entire `verifyMirroredSources` function body with:

```js
async function verifyMirroredSources() {
  // 1. Byte-exact mirrors: src/shared/* must equal src/public/shared/* verbatim.
  const exactMirrors = ["shared/protocol.js", "shared/planLimits.js"];
  for (const relativePath of exactMirrors) {
    const [localSource, cloudSource] = await Promise.all([
      readFile(path.join(projectRoot, "src", relativePath), "utf8"),
      readFile(path.join(publicDir, relativePath), "utf8")
    ]);
    if (localSource !== cloudSource) {
      throw new Error(`Cloud source drift detected: ${relativePath}`);
    }
  }

  // 2. Path-rewritten mirrors: src/public/<file> imports `../shared/<x>.js` (because
  //    it sits next to src/shared at authoring time), but the published cloud copy
  //    lives at public/<file> and must import `./shared/<x>.js`. Normalize before
  //    comparing so the build gate fails only on real drift.
  const cloudFiles = ["app.js", "cloudRealtime.js"];
  for (const relativePath of cloudFiles) {
    const [localSource, cloudSource] = await Promise.all([
      readFile(path.join(projectRoot, "src", "public", relativePath), "utf8"),
      readFile(path.join(publicDir, relativePath), "utf8")
    ]);
    const normalizedLocalSource = localSource.replaceAll(
      /"\.\.\/shared\/([^"]+\.js)"/g,
      '"./shared/$1"'
    );
    if (normalizedLocalSource !== cloudSource) {
      throw new Error(`Cloud source drift detected: ${relativePath}`);
    }
  }
}
```

The change: replace the hard-coded `'"../shared/protocol.js"'` literal with the regex `/"\.\.\/shared\/([^"]+\.js)"/g`. The existing `cloudFiles` list (`app.js`, `cloudRealtime.js`) is preserved as a separate explicitly-named array.

### Step 6.2 — Sanity-check the gate against the current tree

- [ ] Run `cd /Users/hl/Projects/VoiceBridge/hosted-pwa && node scripts/build-static.mjs` and confirm it does NOT raise `Cloud source drift detected`. (If it does, the most likely cause is that the previous task forgot to mirror `src/shared/planLimits.js` into `src/public/shared/planLimits.js` byte-for-byte — fix the mirror, do not loosen the gate.)

### Step 6.3 — Commit

```bash
git -C /Users/hl/Projects/VoiceBridge add hosted-pwa/scripts/build-static.mjs
git -C /Users/hl/Projects/VoiceBridge commit -m "refactor(build): generalize ../shared/* rewrite rule in hosted mirror gate"
```

---

## Task 7: Provider Deadline + Fallback Strategy

**Files:**
- `supabase/functions/_shared/tencent_asr.ts` (parameterize `fetchWithTimeout`, add per-stage deadline budget)
- `supabase/functions/_shared/tencent_asr.test.js` (deadline + fallback-classification tests)

**Goal:** Currently `fetchWithTimeout` hard-codes 10 seconds for every call. This blocks the p99 latency SLO: when FlashRecognition is slow (>8s) we still wait the full 10s before falling back, leaving no budget for the SentenceRecognition call. After this task:
- Total provider deadline = 12 seconds (across Flash + SentenceRecognition).
- Flash single-call budget = 8 seconds.
- Fallback to Sentence only happens if remaining budget >= 3 seconds.
- Network/abort errors are classified as "retry-eligible" (immediate fallback); 4xx and non-retryable ASR errors return immediately.

### Step 7.1 — Write RED tests for the deadline and fallback policy

- [ ] Open `supabase/functions/_shared/tencent_asr.test.js`. Append the following tests:

```js
test("transcribeTencentWav passes an 8s timeout to FlashRecognition and a 12s total deadline to SentenceRecognition", async () => {
  const observedTimeouts = [];
  const fetchImpl = async (url, init) => {
    // Record the timeout encoded in init.signal (AbortSignal.timeout exposes .timeout).
    if (init?.signal?.timeout) observedTimeouts.push(init.signal.timeout);
    return new Response(JSON.stringify({ code: 0, flash_result: [{ text: "hello" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  await transcribeTencentWav({
    audioBytes: new Uint8Array([1, 2, 3]),
    requestId: "req-timeout",
    config,
    fetchImpl
  });
  assert.equal(observedTimeouts.length, 1);
  assert.equal(observedTimeouts[0], 8000);
});

test("transcribeTencentWav falls back to SentenceRecognition when Flash exceeds its 8s budget but total deadline remains", async () => {
  const calls = [];
  let flashStartedAt = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url) });
    if (calls.length === 1) {
      // Simulate Flash timeout via abort.
      const signal = init?.signal;
      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", () => {
          // no-op; we just need the signal to fire.
        });
      }
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    return new Response(JSON.stringify({ Response: { Result: "fallback ok" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const text = await transcribeTencentWav({
    audioBytes: new Uint8Array([1]),
    requestId: "req-fallback-after-timeout",
    config,
    fetchImpl
  });
  assert.equal(text, "fallback ok");
  assert.equal(calls.length, 2);
});

test("transcribeTencentWav does NOT fall back when Flash returns a non-retryable HTTP 4xx error", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push({ url: String(url) });
    if (calls.length === 1) {
      // Auth/config error: not eligible for fallback.
      return new Response(JSON.stringify({ code: 4001, message: "invalid appid" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ Response: { Result: "should not reach here" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  // The current behavior is to throw on a hard Flash failure without retrying; the test
  // locks that contract. We assert that the call count stays at 1 (no fallback attempted).
  await assert.rejects(
    () =>
      transcribeTencentWav({
        audioBytes: new Uint8Array([1]),
        requestId: "req-no-fallback-4xx",
        config,
        fetchImpl
      }),
    () => true
  );
  assert.equal(calls.length, 1);
});
```

- [ ] Run the test file and confirm the new tests FAIL (the current `fetchWithTimeout` signature and fallback logic do not yet implement these behaviors).

### Step 7.2 — Parameterize `fetchWithTimeout` and add an `isRetryable` classifier

- [ ] Edit `supabase/functions/_shared/tencent_asr.ts`. Replace the existing `fetchWithTimeout` definition with a parameterized version:

```ts
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  // Surface the timeout via AbortSignal.timeout metadata so tests can observe the
  // per-call budget. AbortSignal.timeout is widely supported in Deno / Node 20+.
  const signal = (controller.signal as unknown) as AbortSignal & { timeout?: number };
  signal.timeout = timeoutMs;
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function isFlashRetryable(error: unknown, response: Response | null): boolean {
  // Non-retryable: HTTP 4xx authentication/config errors.
  if (response && response.status >= 400 && response.status < 500) return false;
  // Retryable: network/abort/timeout errors, or 5xx.
  if (error instanceof Error) {
    const name = error.name;
    if (name === "AbortError" || name === "TimeoutError") return true;
    if (name === "TypeError") return true;  // network failure in fetch
  }
  return true;
}
```

### Step 7.3 — Wire the deadline budget into `transcribeTencentWav`

- [ ] Edit `supabase/functions/_shared/tencent_asr.ts`. Replace the entire body of `transcribeTencentWav` with the deadline-aware version:

```ts
const TOTAL_DEADLINE_MS = 12_000;
const FLASH_TIMEOUT_MS = 8_000;
const FALLBACK_MIN_REMAINING_MS = 3_000;

export async function transcribeTencentWav({
  audioBytes,
  requestId,
  config,
  fetchImpl = fetch
}: {
  audioBytes: Uint8Array;
  requestId: string;
  config: TencentAsrConfig;
  fetchImpl?: typeof fetch;
}) {
  const start = Date.now();

  if (config.appId) {
    try {
      const flashRequest = await createTencentFlashRecognitionRequest({
        audioBytes,
        config
      });
      const response = await fetchWithTimeout(
        fetchImpl,
        flashRequest.url,
        {
          method: "POST",
          headers: flashRequest.headers,
          body: toArrayBuffer(audioBytes)
        },
        FLASH_TIMEOUT_MS
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.code !== 0) {
        throw new Error(payload.message || `HTTP ${response.status}`);
      }
      const text = Array.isArray(payload.flash_result)
        ? payload.flash_result.map((result: { text?: string }) => result?.text || "").join("").trim()
        : "";
      if (!text) throw new Error("Tencent FlashRecognition returned empty text");
      console.info("Tencent ASR provider: FlashRecognition");
      return removeFillerWords(text);
    } catch (error) {
      const elapsed = Date.now() - start;
      const remaining = TOTAL_DEADLINE_MS - elapsed;
      if (!isFlashRetryable(error, null) || remaining < FALLBACK_MIN_REMAINING_MS) {
        throw error;
      }
      console.warn(
        `Tencent FlashRecognition failed after ${elapsed}ms (remaining ${remaining}ms); falling back to SentenceRecognition:`,
        error
      );
    }
  }

  const remaining = Math.max(0, TOTAL_DEADLINE_MS - (Date.now() - start));
  const request = await createTencentSentenceRecognitionRequest({
    audioBase64: bytesToBase64(audioBytes),
    audioLength: audioBytes.byteLength,
    requestId,
    config
  });

  const response = await fetchWithTimeout(
    fetchImpl,
    `https://${ENDPOINT}`,
    {
      method: "POST",
      headers: request.headers,
      body: request.body
    },
    remaining
  );
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.Response?.Error) {
    const tencentError = payload.Response?.Error;
    const message = tencentError
      ? `${tencentError.Code}: ${tencentError.Message}`
      : `HTTP ${response.status}`;
    throw new Error(`Tencent ASR failed: ${message}`);
  }

  const result = payload.Response?.Result;
  if (typeof result !== "string" || !result.trim()) {
    throw new Error("Tencent ASR returned empty text");
  }

  return removeFillerWords(result.trim());
}
```

### Step 7.4 — Update the legacy "falls back" test to remain green

The existing test `"Tencent ASR falls back to SentenceRecognition when FlashRecognition is unavailable"` simulates a Flash failure by returning `{ code: 4003, message: "service not enabled" }` with HTTP 200. Under the new classifier, a `code !== 0` failure with HTTP 200 is treated as retryable (no 4xx response, application-level error). That test should still pass — verify.

- [ ] Run `cd /Users/hl/Projects/VoiceBridge && node --test supabase/functions/_shared/tencent_asr.test.js` and confirm ALL tests PASS (including the original legacy fallback test, the new timeout test, the new retry-after-timeout test, and the new 4xx-no-fallback test).

### Step 7.5 — Commit

```bash
git -C /Users/hl/Projects/VoiceBridge add supabase/functions/_shared/tencent_asr.ts supabase/functions/_shared/tencent_asr.test.js
git -C /Users/hl/Projects/VoiceBridge commit -m "feat(asr): 12s total deadline, 8s Flash budget, classifier-based fallback"
```

---

## Final Verification

After all 7 tasks land, run the complete verification suite:

- [ ] `cd /Users/hl/Projects/VoiceBridge && node --test supabase/functions/_shared/tencent_asr.test.js`
- [ ] `cd /Users/hl/Projects/VoiceBridge && node --test src/server/asr/transcriber.test.js`
- [ ] `cd /Users/hl/Projects/VoiceBridge && node --check src/public/app.js`
- [ ] `cd /Users/hl/Projects/VoiceBridge && node --check src/public/cloudRecorder.js`
- [ ] `cd /Users/hl/Projects/VoiceBridge/hosted-pwa && node scripts/build-static.mjs`
- [ ] `cd /Users/hl/Projects/VoiceBridge && grep -rn "max_audio_seconds" supabase/ src/ hosted-pwa/` and confirm ZERO matches (the field name has been fully retired in code; the only remaining occurrence is the historical `0011_admin_plan.sql` migration which must NOT be edited).
- [ ] `cd /Users/hl/Projects/VoiceBridge && grep -rn "isAdminFastPath" supabase/` and confirm ZERO matches.
- [ ] `cd /Users/hl/Projects/VoiceBridge && grep -rn "55_000\|55秒\|55-second" src/public/` and confirm ZERO matches.
- [ ] `git -C /Users/hl/Projects/VoiceBridge log --oneline cloud-activation ^cloud-activation@{7}` and confirm 7 commits land in order (Tasks 1–7).

## Notes & Constraints

1. **Do NOT edit `0011_admin_plan.sql`.** The new `0015_align_cloud_asr_limits.sql` redefines the function via `create or replace function`; the historical migration stays as a record of the original schema.
2. **Test runner:** `node --test` with Node 20+ native TypeScript support. Edge tests import directly via `from "./tencent_asr.ts"`. Do NOT add a build step.
3. **`EdgeRuntime.waitUntil` is only available inside `transcribe/index.ts`.** Do not extract it into a shared module — the test environment has no `EdgeRuntime` global.
4. **Commits use conventional commit format** (`feat`, `fix`, `test`, `docs`, `refactor`). Each task ends with exactly one commit so the orchestrator can rebase or revert at task granularity.
5. **`src/shared/planLimits.js` and `src/public/shared/planLimits.js` must be byte-identical.** Task 6's build gate enforces this; if you edit one, edit the other in the same commit.
6. **AudioWorklet is explicitly out of scope** for this iteration. The `createScriptProcessor` path stays; do not "modernize" it here.
7. **Admin cap is 60 seconds, not 600 seconds.** This was confirmed in spec v3.

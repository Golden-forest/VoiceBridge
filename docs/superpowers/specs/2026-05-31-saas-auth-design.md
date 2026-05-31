# VoiceBridge SaaS: User Auth & Cross-Network Access

**Date**: 2026-05-31
**Status**: Approved
**Scope**: Phase 1-6 implementation plan

## Decisions

| Decision | Choice |
|----------|--------|
| Deployment model | SaaS public service |
| Architecture | Cloud server + Desktop Agent |
| Backend stack | Supabase (Auth, DB, Realtime, Storage, Edge Functions) |
| ASR billing | Platform-provided (unified Tencent Cloud credentials) |
| Desktop Agent form | Electron app (cross-platform: macOS, Windows, Linux) |
| Registration | Email + password (Supabase Auth) |
| Phone client | Existing Web PWA (any browser) |

## Architecture

### System Components

```
Phone Web (PWA)                  Supabase Cloud                  Desktop Agent (Electron)
    |                                |                                |
    |-- register/login ----------->| Auth (email+password)          |
    |-- upload audio ------------->| Storage (audio-uploads)        |
    |                           Edge Function (ASR)                 |
    |                           - receive audio from Storage       |
    |                           - ffmpeg convert to WAV 16kHz      |
    |                           - Tencent Cloud ASR                |
    |                           - return text                      |
    |<-- ASR result -------------|                                |
    |                               |                                |
    |-- send text/command -------->| Realtime Broadcast              |
    |                               |--- device-{userId} ---------->|
    |                               |    (text, key commands)        |
    |                               |                                |--> clipboard write
    |                               |                                |--> keyboard simulate
    |                               |                                |
    |-- commands CRUD ----------->| DB (commands table, RLS)       |
```

### Core Data Flows

**Voice transcription:**
1. Phone records audio via MediaRecorder API
2. Upload to Supabase Storage (audio-uploads bucket)
3. Call Edge Function `/transcribe`
4. Edge Function: read audio from Storage, convert with ffmpeg, call Tencent ASR, return text
5. Phone displays result
6. Phone sends text via Realtime Broadcast on channel `device-{userId}`
7. Desktop Agent receives broadcast, writes to clipboard, optionally auto-pastes

**Key commands:**
1. Phone user taps Enter/Undo/Escape/etc button
2. Phone sends Realtime Broadcast `{ type: "key", key: "enter" }`
3. Desktop Agent receives, simulates keystroke via platform-specific API

### Key Design Decisions

- **Realtime channel naming**: `device-{userId}` — one channel per user, both phone and Agent subscribe
- **Audio does NOT go through Realtime**: Large files go to Supabase Storage; only small text/key messages go through Realtime
- **Edge Function processes in one call**: Audio transcoding + ASR in a single function invocation
- **Code reuse**: `tencentCloudTranscriber.js` migrates to Edge Function; `clipboard.js`/`paste.js` migrate to Desktop Agent
- **Cross-platform**: All device combos supported (macOS+iPhone, Windows+Android, etc.)

### Audio Format Strategy (Important)

Supabase Edge Functions run on Deno, which does NOT have native `ffmpeg`. The current `audioConverter.js` uses `child_process.spawn` to call ffmpeg, which won't work in Deno.

**Solution: Eliminate server-side ffmpeg by configuring Tencent ASR to accept browser-native formats directly.**

Mobile browser MediaRecorder outputs:
- iOS Safari: `audio/mp4` (AAC codec)
- Android Chrome: `audio/webm` (Opus codec)

Tencent ASR `SentenceRecognition` (SubServiceType=2) supports `VoiceFormat` values: `mp3`, `wav`, `pcm`, `ogg_opus`, `m4a`, `silk`, `webm`. We can set `VoiceFormat` dynamically based on the uploaded file's MIME type, bypassing ffmpeg entirely:

```
audio/mp4  → VoiceFormat = "m4a"
audio/webm → VoiceFormat = "webm"
```

This simplifies the Edge Function to: receive base64 audio from request body, detect format, call Tencent ASR directly. No ffmpeg needed, no Deno compatibility issues.

**Fallback**: If quality issues arise with direct browser formats, Phase 2 can use `ffmpeg.wasm` in the Edge Function or do in-browser WAV conversion via Web Audio API before upload.

## Database Schema

### Tables

```sql
-- Devices: one user can bind multiple Desktop Agents
create table devices (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,           -- e.g. "MacBook Pro", "Office PC"
  platform    text not null default 'macos',  -- 'macos' | 'windows' | 'linux'
  last_seen   timestamptz,             -- last heartbeat timestamp
  created_at  timestamptz default now()
);

-- Commands: replaces commands.json file
create table commands (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  label       text not null,
  text        text not null,
  category    text not null default 'uncategorized',
  sort_order  int not null default 0,
  is_favorite boolean not null default false,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Transcriptions: usage tracking
create table transcriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  device_id   uuid references devices(id),
  text        text not null,
  audio_size  int,
  duration_ms int,
  created_at  timestamptz default now()
);
```

### RLS Policies

All tables use Row Level Security to ensure data isolation:

```sql
alter table devices enable row level security;
create policy "users manage own devices"
  on devices for all using (user_id = auth.uid());

alter table commands enable row level security;
create policy "users manage own commands"
  on commands for all using (user_id = auth.uid());

alter table transcriptions enable row level security;
create policy "users manage own transcriptions"
  on transcriptions for all using (user_id = auth.uid());
```

### Auth Configuration

- Supabase Auth built-in email registration
- Email confirmation template customizable
- JWT contains `auth.uid()`, used directly by RLS

### Storage

One bucket `audio-uploads`:
- Authenticated users only, max 25MB, audio MIME types only
- Files auto-expire after 24 hours (cron Edge Function cleanup)

## Device Binding Flow

1. User registers on phone Web via Supabase Auth (email + password)
2. User downloads Desktop Agent (platform-specific installer)
3. Opens Agent, logs in with same email/password
4. Agent auto-registers as device in `devices` table
5. Agent subscribes to Realtime channel `device-{userId}`
6. Phone settings page shows bound devices and online status

No separate pairing code needed — same account = same `user_id`.

## Project Structure

```
voicebridge/
├── src/
│   ├── web/                     # Web frontend (existing PVA, modified)
│   │   ├── index.html
│   │   ├── app.js
│   │   ├── style.css
│   │   ├── auth.js              # [NEW] Login/register UI + Supabase client
│   │   └── manifest.json
│   ├── agent/                   # [NEW] Desktop Agent (Electron)
│   │   ├── main.js              # Electron main process
│   │   ├── preload.js           # Security bridge
│   │   ├── renderer/            # Tray menu + status window UI
│   │   ├── clipboard.js         # [REUSED] from existing code
│   │   ├── paste.js             # [REUSED] from existing code
│   │   └── package.json
│   └── shared/                  # [NEW] Shared constants and protocol definitions
│       └── realtime-protocol.js
├── supabase/
│   ├── functions/transcribe/    # [NEW] Edge Function (ASR)
│   │   └── index.ts             # [REUSED] tencentCloudTranscriber logic
│   └── migrations/              # [NEW] SQL migration files
└── package.json
```

## Implementation Phases

| Phase | Content | Dependencies | Est. Time |
|-------|---------|-------------|-----------|
| **Phase 1** | Supabase project setup + Auth + DB schema + Web frontend login | None | 1 week |
| **Phase 2** | ASR Edge Function + Storage + transcription flow | Phase 1 | 1 week |
| **Phase 3** | Realtime relay + commands migration to DB | Phase 2 | 3-4 days |
| **Phase 4** | Desktop Agent CLI prototype (validate data flow) | Phase 3 | 1 week |
| **Phase 5** | Desktop Agent Electron GUI + system tray | Phase 4 | 1-2 weeks |
| **Phase 6** | Usage tracking + device online status + polish | Phase 5 | 3-4 days |

**Phase 1 milestone**: User can register/login on phone, see authenticated state, empty device list. Validates the entire auth chain.

## Reusable Code (from Current Codebase)

| Current file | Migrates to | Notes |
|---------------|-------------|-------|
| `server/asr/tencentCloudTranscriber.js` | `supabase/functions/transcribe/index.ts` | TC3 signing logic, retry logic, base64 encoding |
| `server/asr/audioConverter.js` | `supabase/functions/transcribe/index.ts` | ffmpeg conversion (Edge Function needs ffmpeg in environment) |
| `server/input/clipboard.js` | `agent/clipboard.js` | clipboardy, cross-platform |
| `server/input/paste.js` | `agent/paste.js` | osascript/PowerShell/xdotool, already multi-platform |
| `public/app.js` (recording, UI) | `src/web/app.js` | Keep, modify to use Supabase Auth client and Realtime |
| `public/style.css` | `src/web/style.css` | Keep as-is, add auth page styles |

## Security Considerations

- All API/WS access authenticated via Supabase Auth JWT
- RLS prevents cross-user data access at database level
- Realtime channels scoped by userId — no cross-user message leakage
- Desktop Agent only receives commands for its own user
- Tencent ASR credentials stored as Supabase Edge Function secrets (never exposed to client)
- Storage uploads restricted to authenticated users with MIME type validation

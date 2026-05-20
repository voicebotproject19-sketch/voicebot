# VoiceBot — Platform Summary

**AI-Sales-Representative v1.1.0** — An enterprise real-time voice agent platform built on Node.js that conducts outbound sales calls using AI-driven conversation.

---

## What It Does

VoiceBot places outbound phone calls on behalf of sales teams, carries on natural voice conversations with prospects using Azure OpenAI Realtime, and persists every interaction for follow-up. It supports multiple telecom carriers, languages, and configurable sales personas — all from a single deployment.

---

## Core Features

| Category | Feature |
|----------|---------|
| **Telephony** | Dual-carrier support (Twilio worldwide, Plivo for India) with automatic provider selection by country code. Outbound call creation via REST API, inbound webhook handling, and real-time WebSocket media streaming. |
| **AI Conversation** | Azure OpenAI Realtime integration over WebSocket for low-latency, streaming voice-to-voice dialogue. Server-side VAD (voice activity detection), barge-in recovery, and configurable silence timeouts. |
| **Persona System** | Pluggable persona registry with per-persona knowledge bases, language packs, tone profiles, and style passes. New personas are auto-loaded from the `personas/` directory. |
| **Multilingual** | Per-persona language resolution with fallback chains. Supports English and additional languages with optional merged English knowledge bases for non-English calls. |
| **Knowledge Retrieval** | In-repo knowledge bases loaded per persona and language. RAG guardrails, numeric enforcement, and synthesis scoring ensure factual, on-topic responses. |
| **Call Intelligence** | Real-time call classification (screening, voicemail, garble detection), conversation phase tracking, complexity detection, and context summarization across turns. |
| **Policy & Safety** | Interaction policy engine, degradation state machine, ambiguity scoring, hallucination guard, and escalation/handover decision logic. Formal unlock and degradation control spec. |
| **Latency Optimization** | Latency-responsiveness tuning with pre-warm strategies, micro-acknowledgements, pacing control, and tiered latency configuration to keep conversations feeling natural. |
| **Audio Processing** | RNNoise-based denoising pipeline, PCM/μ-law codec transcoding, and provider-specific media format handling. |
| **Persistence** | MySQL database with serialized write queue, call session repository, conversation history, and user records. Migration-managed schema. |
| **Observability** | OpenTelemetry + Azure Monitor integration, structured logging, per-call telemetry spans, and CI-enforced telemetry contracts. |
| **Email Handover** | SMTP-based email escalation when a call requires human follow-up. |
| **Security** | Helmet, CORS, express-rate-limit, input validation via Zod, and prompt-injection sanitisation. |

---

## Architecture at a Glance

```
HTTP Request (POST /api/call)
  → MainController (persona + provider resolution)
    → Twilio / Plivo Provider Adapter (creates call)
      → WebSocket Media Stream
        → Noise Reducer → Azure OpenAI Realtime (voice ↔ voice)
          → Policy Engine + Hallucination Guard
            → Persona-driven response → Audio back to caller
              → Write Queue → MySQL (call records, conversations)
```

**Key layers:** Telecom adapters → Shared session orchestrator → AI realtime engine → Policy & guardrails → Persistence & telemetry.

---

## Tech Stack

Node.js · Express 5 · WebSockets (ws) · Azure OpenAI Realtime · Twilio SDK · Plivo SDK · MySQL (mysql2) · OpenTelemetry · RNNoise · Zod · Docker · PM2

---

## Governance

- **1,181 automated tests** across 32 suites
- CI drift validators for adapter compliance, provider behavior, telemetry contracts, and event schemas
- Formal specifications for degradation control, epoch isolation, and conversational intelligence
- Staged implementation phases (1–4) with per-phase validation and acceptance criteria

# Telemetry Metric Pipeline Audit

**Date:** 2026-05-07  
**Status:** Validated and hardened  
**Dashboard:** `observability/azure-monitor-workbook.json`  
**Deployment:** `infra/main.bicep`

## Current Azure Approach

The telemetry stack uses the Azure Monitor OpenTelemetry distro for Node.js, a workspace-based Application Insights resource backed by Log Analytics, Azure Monitor Workbooks for the dashboard, and scheduled query rules for alerts. This matches the current Azure Monitor direction and keeps the deployment managed through Bicep.

## Metric Pipeline Review

| Dashboard or alert metric | Source events | Key dimensions | Validation result |
|---|---|---|---|
| End-to-end call timeline | Telecom status, realtime lifecycle, user speech, transcript, latency, speech playback, booking, transfer/hangup, finalization, and summary events | `eventName`, `callId`, `turnId`, provider, phase, outcome | Hardened. The timeline now includes critical lifecycle, reconnect, failure, transfer, hangup, booking, and finalization stages for call-level reconstruction. |
| Total calls | `call_summary` | `callId` with `callSID`/`callSid`/`sid` fallback | Complete. One latest summary per call is used with `arg_max(timestamp, *)`. |
| Completed bookings | `booking_completed_webhook`, `call_summary` | `callId`, `bookingCompleted`, `outcome` | Hardened. Provider-confirmed webhooks are counted even when they arrive after call finalization. |
| Booking funnel | `booking_intent_detected`, `booking_link_requested`, `booking_link_delivery_sent`, `booking_link_sent`, `booking_completed_webhook`, completed `call_summary` | `callId`, stage timestamp | Complete. Booked stage is deduped per call and no longer depends only on call-end summary data. |
| Intent-cohort booking conversion | `booking_intent_detected`, `booking_link_requested`, `booking_link_delivery_sent`, `booking_link_sent`, `booking_completed_webhook`, completed `call_summary` | `callId`, first intent timestamp | Complete. Separates booking-flow conversion after caller intent from global call-to-booking rate. |
| Orphan booking webhooks | `booking_webhook_orphaned` | provider, provider event type, status, reason, correlation status | Complete. Completed/cancelled provider callbacks without trusted call correlation are visible without counting as attributed completions. |
| Revenue | `call_summary`, `booking_completed_webhook` | `estimatedRevenueUsd`, `outcome`, `bookingCompleted` | Hardened. Non-completion revenue comes from final call outcome; completed-booking revenue comes from webhook/summary completion signals without double counting. |
| Cost | `call_summary` | `estimatedCostUsd`, `tokenCostUsd`, `callTransportCostUsd` | Complete for per-call estimate model. Cost is tied to the finalized call because token and transport data are call-level. |
| Gross profit and ROI | Derived from revenue and cost | `estimatedGrossProfitUsd`, `roiRatio` | Hardened. Dashboard recomputes ROI from deduped revenue and call cost totals. |
| Business metrics by persona | `call_summary` joined to completion signals | `persona`, `callId`, revenue/cost fields | Complete. Blank persona is grouped as `unknown`; late webhook completions are attributed through call summary join. |
| Daily revenue, cost, and ROI | `call_summary`, `booking_completed_webhook` | call day for cost, completion day for completed-booking revenue | Accurate for operations reporting. Costs land on call day; completed-booking revenue lands on completion day. |
| Response latency P50/P95/P99 | `response_latency` | `responseLatencyMs`, `latencyMs` | Complete. Null latency rows are filtered out; both field names are supported. |
| Error count alert and chart | `rag_error`, `realtime_connection_error`, `realtime_service_error`, `booking_provider_error`, `call_finalization_degraded`, `uncaught_exception`, `unhandled_rejection` | `eventName`, `callId` where present | Complete. All referenced events are registered in `Utils/telemetryEvents.js`. |
| Drift and carrier quality | `behavior_drift_detected` | `driftFlags`, `carrierQualityScore`, `callId` | Complete. Logger-generated drift events are registered and emitted into the normal telemetry pipeline. |
| Token usage | `realtime_usage` | `input_tokens`, `output_tokens`, camelCase fallbacks | Complete. Workbook supports current snake_case fields and camelCase fallback fields. Call-level token cost is stored on `call_summary`. |
| Booking completion alert | `call_summary`, `booking_completed_webhook` | `callId`, `outcome`, `bookingCompleted` | Hardened. Uses all completion signals divided by total finalized calls. |
| Booking intent drop-off alert | `booking_intent_detected`, `booking_link_requested`, `booking_link_delivery_sent`, `booking_link_sent`, `booking_completed_webhook` | `callId` | Complete. Alerts separately when intent-stage calls stop reaching delivery/completion. |
| Orphan webhook alert | `booking_webhook_orphaned` | provider/reason dimensions in workbook | Complete. Alerts when provider webhooks cannot be attributed to a valid call. |

## Hardening Added

- Shared business metric calculation in `Utils/businessMetrics.js`.
- `booking_completed_webhook` now emits `estimatedRevenueUsd` and `revenueModel`.
- Azure adapter preserves a payload `eventType` as `payloadEventType` before setting the dashboard `eventType` dimension.
- `OTEL_SERVICE_NAME` is honored in the OpenTelemetry resource.
- Workbook and alert KQL use empty-string-safe event-name and call-id fallbacks.
- Workbook and alerts now include separate global booking, intent-cohort booking, and orphan-webhook views.
- `ci/scripts/check-observability-metrics.js` validates workbook and alert event names, metric columns, required timeline lifecycle events, booking completion coverage, token field fallbacks, webhook revenue plumbing, intent-cohort coverage, and orphan-webhook coverage.

## Validation Commands

```bash
npm run validate:telemetry
npx jest tests/businessMetrics.test.js tests/callFinalizer.test.js tests/telemetry-adapter.test.js --forceExit
node -e "for (const f of ['observability/azure-monitor-workbook.json','observability/azure-alert-rules.json']) { JSON.parse(require('fs').readFileSync(f, 'utf8')); console.log(f + ' ok'); }"
git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --check
```

Azure CLI and standalone Bicep CLI were not installed in the local shell, so `infra/main.bicep` could not be compiled locally here. The template has no VS Code diagnostics, and deployment docs require `az deployment group what-if` before `az deployment group create`.

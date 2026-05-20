# Dealer Order Persona

Persona id: `dealer-orders`

This persona captures replenishment orders from existing dealers. It greets the dealer, references CRM context, captures spoken product names and quantities, summarizes the order, waits for explicit confirmation, then generates an order ID and submits the confirmed order to the configured ERP endpoint.

Use this doc with [persona-bot-creation-runbook.md](./persona-bot-creation-runbook.md). The dealer-order persona is an action workflow, not a prompt-only bot, because it captures structured items and can trigger ERP, SMS, email, retry, and fallback side effects.

## Call Payload

Use the existing outbound call API:

```json
{
  "phoneNumber": "+15551234567",
  "name": "Apex Auto Parts",
  "persona": "dealer-orders",
  "language": "en",
  "contextHint": "{\"dealerId\":\"D-1024\",\"dealerName\":\"Apex Auto Parts\",\"dealerEmail\":\"orders@example.com\",\"lastOrder\":\"20 cases of engine oil on 2026-04-28\",\"monthlyTargetPercent\":85,\"milestonePrompt\":\"This order could unlock Tier 2 bonuses.\",\"triggerReason\":\"approaching_sales_milestone\",\"selfServiceUrl\":\"https://orders.example.com/self-service/D-1024\"}"
}
```

`contextHint` can be plain text, but JSON is preferred. Supported JSON fields are `dealerId`, `dealerName`, `dealerEmail`, `lastOrder`, `monthlyTargetPercent`, `milestonePrompt`, `triggerReason`, `selfServiceUrl`, and `notes`.

## Runtime Behavior

- Product and quantity phrases such as "10 cases of engine oil and 4 brake pads" are parsed deterministically.
- The bot summarizes captured items and asks for explicit confirmation.
- On confirmation, it generates an order ID like `DO-20260509-3FA92B`.
- `DEALER_ORDER_ERP_ENDPOINT` receives the confirmed order payload by HTTP POST.
- SMS/email confirmations are attempted according to `DEALER_ORDER_DELIVERY_ORDER`.
- Missed dealer-order calls can schedule in-process retries and then send the self-service fallback SMS when enabled.

## Workflow Stages

Dealer-order progress is tracked separately from the universal conversation phase.

| Stage | Meaning |
|-------|---------|
| `open` | Dealer-order call is active and waiting for items. |
| `awaiting_confirmation` | One or more items were captured and summarized. |
| `confirmed` | Dealer explicitly confirmed the summarized order. |
| `skipped` | Dealer declined or deferred the order. |
| `erp_logged` | ERP submission succeeded. |
| `erp_failed` | ERP submission failed or was not configured. |
| `notification_sent` | At least one SMS/email confirmation was sent. |
| `notification_failed` | All enabled confirmation channels failed. |

Current runtime stores this state on `realtimeService.dealerOrder` and mirrors part of it in `CallRegistry`. ERP and notification side effects are executed through the durable `workflow_action_outbox` table after migration 013 is applied.

## Guardrails And Phase 4

- Gate 4 noisy-transcript suppression can stop garbled turns before dealer-order item extraction runs.
- The deterministic parser only accepts product/quantity turns with explicit numeric structure.
- The adapter summarizes captured items and requires an explicit confirmation phrase before emitting `dealer_order_confirmed`.
- Skip/later/no-order phrases close the workflow without ERP submission.
- The persona prompt must not invent target progress, bonus tier, price, stock, credit, tax, delivery date, or ERP status.
- Phase 4 protects generated conversational turns, and the scripted dealer-order confirmation now routes through the shared action guard before durable side-effect enqueueing.
- Production release requires migration `013_workflow_action_outbox.sql` so ERP and notification work goes through durable idempotent action execution.

## Telemetry

Dealer lifecycle events are allowlisted in `Utils/telemetryEvents.js`:

| Event | Purpose |
|-------|---------|
| `dealer_order_items_captured` | Items were parsed and summarized for confirmation. |
| `dealer_order_confirmed` | Dealer explicitly confirmed the order. |
| `dealer_order_skipped` | Dealer skipped or deferred the order. |
| `dealer_order_erp_logged` | ERP submission succeeded. |
| `dealer_order_erp_failed` | ERP submission failed or was skipped because ERP is unconfigured. |
| `dealer_order_notification_sent` | SMS/email confirmation succeeded on at least one channel. |
| `dealer_order_notification_failed` | Enabled confirmation channels failed. |
| `dealer_order_missed_call` | Provider reported a missed terminal status. |
| `dealer_order_retry_scheduled` | Retry call creation was scheduled/attempted. |
| `dealer_order_retry_failed` | Retry call creation failed. |
| `dealer_order_fallback_sent` | Fallback self-service SMS was sent. |
| `dealer_order_fallback_failed` | Fallback SMS was disabled, unconfigured, or failed. |
| `action_outbox_enqueued` | Durable workflow side-effect action was recorded. |
| `action_outbox_claimed` | Outbox worker/session claimed a due side-effect action. |
| `action_outbox_completed` | Outbox action completed successfully. |
| `action_outbox_failed` | Outbox action failed and was retried or dead-lettered. |

## Outcome And ROI

The current implementation adds dealer-order fields to the call summary payload, including confirmation status, skipped status, order ID, item count, ERP status, and notification status.

Confirmed and skipped dealer orders are first-class call outcomes: `dealer_order_confirmed` and `dealer_order_skipped`. Confirmed orders use `VOICEBOT_DEALER_ORDER_CONFIRMED_VALUE_USD` in the existing business metrics layer. Do not use target progress or milestone prompts as revenue values.

## Required Configuration

Set these for production order handling:

```env
DEALER_ORDER_COMPANY_NAME=Your Company
DEALER_ORDER_ERP_ENDPOINT=https://erp.example.com/api/orders
DEALER_ORDER_ERP_AUTH_TOKEN=...
DEALER_ORDER_SELF_SERVICE_URL=https://orders.example.com/self-service
DEALER_ORDER_NOTIFICATION_EMAIL=orders@example.com
DEALER_ORDER_DELIVERY_ORDER=sms,email
DEALER_ORDER_SMS_ENABLED=true
DEALER_ORDER_EMAIL_ENABLED=true
DEALER_ORDER_MESSAGING_PROVIDER=auto
DEALER_ORDER_RETRY_ENABLED=true
DEALER_ORDER_MAX_RETRIES=2
DEALER_ORDER_RETRY_DELAY_MS=300000
DEALER_ORDER_FALLBACK_SMS_ENABLED=true
ACTION_OUTBOX_WORKER_ENABLED=true
ACTION_OUTBOX_POLL_INTERVAL_MS=5000
ACTION_OUTBOX_MAX_BATCH=5
ACTION_OUTBOX_RETRY_DELAY_MS=30000
```

Email delivery requires the shared SMTP variables. SMS delivery uses the existing Twilio or Plivo messaging variables.

## Tests And Validation

Focused tests cover deterministic parsing, persona registration/prompt context, service payloads, ERP submission, notification fallback, missed-call fallback SMS, call context durability, and dealer outcome/ROI mapping:

```bash
npm test -- --runTestsByPath tests/dealerOrderParser.test.js tests/dealerOrdersPersona.test.js tests/dealerOrderService.test.js tests/callContextRepository.test.js tests/callContextStore.test.js tests/businessMetrics.test.js tests/callFinalizer.test.js
```

Run these validators after config or telemetry changes:

```bash
npm run validate:env
npm run validate:telemetry
git diff --check
```

Remaining test coverage before production:

- Duplicate confirmation suppression.
- ERP timeout, HTTP failure, and unconfigured behavior.
- Missed-call retry scheduling.
- Wider restart/replay integration behavior with a real MySQL database.
- Operational alerting around failed or dead-letter outbox actions.

## Triggering Calls

Dealer inactivity, scheduled intervals, and approaching milestones should be decided by CRM/campaign orchestration. When a dealer qualifies, call `/api/call` with `persona: "dealer-orders"` and include the trigger and milestone context in `contextHint`.

## Production Readiness Notes

The current dealer-order path is suitable as a baseline implementation and demoable pilot skeleton. Before production use for real irreversible orders, complete these gates:

1. Apply migration 011 so `contextHint` is not truncated and `dealerOrder` state patches persist.
2. Apply migration 012 so dealer-order outcomes can be written to `call_outcomes`.
3. Apply migration 013 so confirmed dealer orders are written to the durable action outbox before ERP/SMS/email side effects run.
4. Monitor `action_outbox_failed`, `action_outbox_poll_failed`, and `dead_letter` rows before enabling production ERP endpoints.
5. Add broader duplicate/retry/replay integration tests around real ERP provider failures.
6. Continue env ownership split now that validation supports core plus feature/persona env files.

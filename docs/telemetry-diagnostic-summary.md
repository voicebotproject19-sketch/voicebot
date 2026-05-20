# Telemetry Layer Diagnostic Summary

> **2026-05-07 update:** This March diagnostic is superseded for current Azure Monitor readiness by `docs/telemetry-metric-pipeline-audit.md`. The current implementation uses workspace-based Application Insights, Azure Monitor OpenTelemetry, a deployable Workbook/Bicep stack, and a metric-contract validator wired into `npm run validate:telemetry`.

**Date:** 2026-03-10  
**Status:** Diagnostic Analysis Complete  
**Diagnostic Tool:** `ci/scripts/diagnose-telemetry.js`

---

## Executive Summary

A comprehensive diagnostic analysis was performed on the VoiceBot telemetry layer to verify connectivity and operational status between source agents and backend infrastructure. The analysis revealed that while the telemetry infrastructure is properly implemented, it is currently **not operational** due to missing configuration and dependencies.

### Overall Status: ⚠️ **NOT OPERATIONAL**

| Component | Status | Priority |
|-----------|--------|----------|
| Telemetry Code | ✅ Complete | - |
| Event Definitions | ✅ Complete | - |
| Application Integration | ✅ Complete | - |
| Dependencies | ❌ Not Installed | HIGH |
| Configuration | ❌ Not Configured | CRITICAL |
| Network Connectivity | ❌ Cannot Test | CRITICAL |
| Data Transmission | ❌ Not Active | CRITICAL |
| Dashboard Visibility | ❌ No Data | CRITICAL |

---

## Diagnostic Results

### ✅ Passed Checks (24)

1. **Telemetry Module Files Exist**
   - `Utils/telemetry.js` ✅
   - `Utils/telemetryEvents.js` ✅
   - `Utils/logger.js` ✅

2. **Telemetry Modules Load Successfully**
   - telemetryEvents module ✅
   - telemetryAdapter module ✅
   - azureTelemetryAdapter module ✅

3. **Telemetry Events Defined**
   - 23 events defined ✅
   - All critical events present ✅

4. **Application Integration**
   - Telemetry imported in app.js ✅
   - 52 telemetry.emit() calls found ✅

5. **Dependencies Declared**
   - @azure/monitor-opentelemetry ✅
   - @opentelemetry/sdk-trace-node ✅
   - @opentelemetry/sdk-trace-base ✅
   - @opentelemetry/api ✅
   - applicationinsights ✅

### ❌ Failed Checks (5)

1. **Missing .env File**
   - `.env` file does not exist
   - Configuration cannot be loaded

2. **Telemetry Not Enabled**
   - `VOICEBOT_TELEMETRY` not set to `true`
   - Current value: `undefined`

3. **No Azure Connection String**
   - `AZURE_MONITOR_CONNECTION_STRING` not configured
   - Cannot send data to Azure Monitor

4. **Dependencies Not Installed**
   - `node_modules` directory missing
   - Packages not available at runtime

5. **Logs Directory Missing**
   - `logs` directory does not exist
   - Will be created on initialization

### ⚠️ Warnings (3)

1. **.env.example Exists But .env Missing**
   - Template available but not configured

2. **Logger Initialization Not Explicit**
   - Logger.init() called automatically on first emit
   - Not a problem, just informational

3. **Network Connectivity Test Skipped**
   - Cannot test without connection string
   - Will be tested after configuration

---

## Critical Issues Requiring Immediate Attention

### Issue 1: Missing Environment Configuration

**Impact:** Telemetry cannot function without configuration

**Solution:**
```bash
# Create .env file from template
copy .env.example .env  # Windows
cp .env.example .env    # Linux/Mac

# Edit .env and set required variables:
VOICEBOT_TELEMETRY=true
AZURE_MONITOR_CONNECTION_STRING=InstrumentationKey=YOUR_KEY;IngestionEndpoint=https://YOUR_REGION.in.applicationinsights.azure.com/
```

**Priority:** CRITICAL

---

### Issue 2: Dependencies Not Installed

**Impact:** Telemetry packages not available at runtime

**Solution:**
```bash
npm install
```

**Priority:** HIGH

---

### Issue 3: No Azure Monitor Connection

**Impact:** Cannot send telemetry data to backend infrastructure

**Solution:**
1. Navigate to Azure Portal
2. Open Application Insights resource
3. Copy Connection String from "Overview" → "Essentials"
4. Add to `.env`:
   ```env
   AZURE_MONITOR_CONNECTION_STRING=InstrumentationKey=YOUR_KEY;IngestionEndpoint=https://YOUR_REGION.in.applicationinsights.azure.com/
   ```

**Priority:** CRITICAL

---

## Telemetry Architecture Overview

### Data Flow

```
Application (app.js)
    ↓ telemetry.emit()
Telemetry Entry Point (Utils/telemetry.js)
    ↓ logger.emit()
Logger Module (Utils/logger.js)
    ├─→ Local File (logs/voicebot-events.jsonl)
    └─→ Telemetry Adapter (adapters/telemetry/telemetryAdapter.js)
        └─→ Azure Adapter (adapters/telemetry/azureTelemetryAdapter.js)
            └─→ Azure Monitor (HTTPS)
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| **Telemetry API** | `Utils/telemetry.js` | Public interface for emitting events |
| **Event Registry** | `Utils/telemetryEvents.js` | Defines 23 valid event types |
| **Core Logger** | `Utils/logger.js` | Buffers, flushes, writes to file |
| **Adapter Interface** | `adapters/telemetry/telemetryAdapter.js` | Vendor-neutral abstraction |
| **Azure Exporter** | `adapters/telemetry/azureTelemetryAdapter.js` | OpenTelemetry implementation |

### Configuration

| Setting | Value | Description |
|---------|-------|-------------|
| Max Buffer Size | 1000 events | Maximum events in memory |
| Flush Interval | 1000ms | Time between flushes |
| Max Batch Size | 512 events | Events per Azure batch |
| Max File Size | 50MB | Log file rotation threshold |
| Timeline Limit | 200 events | Per-call event limit |

---

## Telemetry Events (23 Total)

### Lifecycle Events
1. `mode_transition` - Mode changes (INTERACTIVE, DEGRADED, etc.)
2. `turn_created` - New conversation turn started
3. `turn_snapshot` - Turn state captured
4. `turn_interrupted` - Turn interrupted by user
5. `turn_closed` - Turn completed

### Speech Events
6. `speech_started` - TTS generation started
7. `speech_playback_started` - Audio playback started
8. `speech_emitted` - Audio sent to telecom
9. `speech_cancelled` - Speech cancelled
10. `speech_completed` - Playback finished
11. `user_speech_started` - User began speaking
12. `audio_buffer_received` - Audio buffer from telecom

### Conversation Events
13. `user_turn_completed` - User turn finished
14. `clarification_emitted` - Clarification sent
15. `micro_ack_emitted` - Micro-acknowledgment sent
16. `hangup_triggered` - Call ended
17. `unlock_granted` - Unlock granted
18. `tts_queue_depth` - TTS queue status

### System Events
19. `degradation_state_transition` - Degradation state change
20. `carrier_jitter_sample` - Network jitter measurement
21. `call-progress-events` - Telecom call progress
22. `pipeline_error` - Pipeline error occurred
23. `realtime_connection_closed` - Connection closed

---

## Immediate Action Plan

### Step 1: Install Dependencies (5 minutes)
```bash
npm install
```

**Verification:**
```bash
dir node_modules  # Windows
ls -la node_modules  # Linux/Mac
```

### Step 2: Create Environment Configuration (5 minutes)
```bash
# Windows
copy .env.example .env

# Linux/Mac
cp .env.example .env
```

**Edit `.env` and set:**
```env
VOICEBOT_TELEMETRY=true
AZURE_MONITOR_CONNECTION_STRING=InstrumentationKey=YOUR_KEY;IngestionEndpoint=https://YOUR_REGION.in.applicationinsights.azure.com/
```

**Verification:**
```bash
type .env  # Windows
cat .env   # Linux/Mac
```

### Step 3: Run Diagnostic Script (1 minute)
```bash
node ci/scripts/diagnose-telemetry.js
```

**Expected Result:** All critical checks pass

### Step 4: Start Application (2 minutes)
```bash
npm start
```

**Expected Output:**
```
[Telemetry] Telemetry initialized
[Telemetry] Azure Monitor exporter configured
```

### Step 5: Verify Telemetry (5 minutes)

**Check Local Logs:**
```bash
dir logs  # Windows
ls -la logs  # Linux/Mac

type logs\voicebot-events.jsonl  # Windows
cat logs/voicebot-events.jsonl  # Linux/Mac
```

**Check Azure Monitor:**
1. Navigate to Application Insights in Azure Portal
2. Go to "Logs"
3. Run query:
   ```kusto
   customEvents
   | where timestamp >= ago(5m)
   | order by timestamp desc
   ```

**Expected Result:** Events visible in both local logs and Azure Monitor

---

## Troubleshooting Resources

### Diagnostic Script
```bash
node ci/scripts/diagnose-telemetry.js
```

### Comprehensive Troubleshooting Guide
See [`docs/telemetry-troubleshooting-checklist.md`](telemetry-troubleshooting-checklist.md) for:
- Step-by-step troubleshooting procedures
- Common issues and solutions
- Network connectivity tests
- Dashboard configuration
- Performance optimization

### Key Documentation Files
- `docs/telemetry-troubleshooting-checklist.md` - Full troubleshooting guide
- `.env.example` - Configuration template
- `Utils/telemetry.js` - Telemetry API documentation
- `Utils/logger.js` - Logger implementation details

---

## Monitoring and Verification

### Daily Checks
- [ ] Telemetry events appearing in Azure Monitor
- [ ] No error logs in console
- [ ] No buffer overflow warnings

### Weekly Checks
- [ ] Review telemetry data quality
- [ ] Check for data gaps
- [ ] Verify dashboard accuracy

### Monthly Reviews
- [ ] Review and optimize event definitions
- [ ] Analyze event emission rates
- [ ] Review Azure Monitor costs

---

## Next Steps

1. **Complete Configuration** (15 minutes)
   - Install dependencies
   - Create .env file
   - Set connection string

2. **Verify Operation** (10 minutes)
   - Run diagnostic script
   - Start application
   - Test event emission

3. **Monitor Performance** (Ongoing)
   - Check local logs
   - Verify Azure Monitor data
   - Review dashboard

4. **Optimize as Needed** (As required)
   - Reduce event volume
   - Adjust buffer sizes
   - Optimize network settings

---

## Support and Resources

### Internal Documentation
- Full troubleshooting guide: `docs/telemetry-troubleshooting-checklist.md`
- Configuration template: `.env.example`
- Diagnostic tool: `ci/scripts/diagnose-telemetry.js`

### External Resources
- Azure Monitor Documentation: https://docs.microsoft.com/azure/azure-monitor/
- OpenTelemetry Documentation: https://opentelemetry.io/docs/
- Application Insights SDK: https://github.com/microsoft/ApplicationInsights-node.js

### Getting Help
1. Run diagnostic script first
2. Review troubleshooting checklist
3. Check Azure Portal for resource status
4. Contact Azure Support if issues persist

---

## Summary

The VoiceBot telemetry layer is **well-architected and properly implemented**, but currently **not operational** due to missing configuration and dependencies. All code components are in place and functioning correctly. Once the configuration issues are resolved, the telemetry system will be fully operational and capable of:

- Emitting 23 different event types
- Buffering and flushing events efficiently
- Writing to local log files
- Sending data to Azure Monitor
- Providing real-time monitoring capabilities
- Supporting behavior drift detection
- Calculating carrier quality scores

**Estimated Time to Full Operation: 30 minutes**

---

**Document Status:** ✅ Complete  
**Diagnostic Date:** 2026-03-10  
**Next Review:** After configuration completed

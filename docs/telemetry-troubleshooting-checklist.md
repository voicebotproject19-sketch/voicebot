# Telemetry Layer Troubleshooting Checklist

> **2026-05-07 update:** For the current validated dashboard, alert, and business metric pipeline, see `docs/telemetry-metric-pipeline-audit.md`. This older checklist remains useful for basic environment setup, but its March status snapshot is no longer the source of truth.

**Document Version:** 1.0  
**Last Updated:** 2026-03-10  
**Purpose:** Comprehensive diagnostic analysis and troubleshooting guide for the VoiceBot telemetry layer

---

## Executive Summary

This document provides a step-by-step troubleshooting checklist to verify connectivity and operational status of the telemetry layer, ensuring data pipelines function correctly between source agents and backend infrastructure.

### Current Diagnostic Status

Based on the comprehensive diagnostic analysis performed on 2026-03-10, the telemetry layer has the following status:

| Component | Status | Details |
|-----------|--------|---------|
| **Telemetry Modules** | ✅ Operational | All telemetry modules exist and load successfully |
| **Event Definitions** | ✅ Operational | 23 telemetry events defined, all critical events present |
| **Application Integration** | ✅ Operational | Telemetry imported in app.js with 52 emit() calls |
| **Dependencies** | ⚠️ Not Installed | Packages declared but node_modules missing |
| **Configuration** | ❌ Not Configured | .env file missing, telemetry not enabled |
| **Network Connectivity** | ❌ Cannot Test | No connection string configured |
| **Log Files** | ❌ Not Created | logs directory does not exist |

### Critical Issues Identified

1. **Missing .env file** - Environment configuration not present
2. **Telemetry Disabled** - `VOICEBOT_TELEMETRY` not set to `true`
3. **No Azure Connection** - `AZURE_MONITOR_CONNECTION_STRING` not configured
4. **Dependencies Not Installed** - `node_modules` directory missing
5. **No Log Files** - Telemetry has never been initialized

---

## Architecture Overview

### Telemetry Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         Application Layer                        │
│  (app.js, MainController.js, realtimeService*.js)               │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     │ telemetry.emit(event, payload)
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Telemetry Entry Point                         │
│  (Utils/telemetry.js)                                           │
│  - Normalizes payload (connectionId, callId, timestamp)         │
│  - Validates event type against EVENTS set                      │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     │ logger.emit(eventType, callId, turnId, payload)
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Logger Module                              │
│  (Utils/logger.js)                                              │
│  - Buffers events (max 1000)                                    │
│  - Flushes every 1000ms                                         │
│  - Writes to ./logs/voicebot-events.jsonl                       │
│  - Calls telemetryAdapter.emitBatch()                           │
│  - Behavior drift detection on hangup_triggered                 │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     │ telemetryAdapter.emitBatch(events)
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Telemetry Adapter                              │
│  (adapters/telemetry/telemetryAdapter.js)                      │
│  - Vendor-neutral interface                                    │
│  - Dynamically loads implementation                             │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     │ azureTelemetryAdapter.emitBatch(events)
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│              Azure Telemetry Adapter                            │
│  (adapters/telemetry/azureTelemetryAdapter.js)                  │
│  - Uses OpenTelemetry SDK                                       │
│  - BatchSpanProcessor (max queue: 2048, batch: 512)             │
│  - Exports to Azure Monitor                                     │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     │ HTTPS POST to Azure Monitor
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│              Azure Monitor / Application Insights               │
│  - Data ingestion and storage                                   │
│  - Monitoring dashboard                                         │
└─────────────────────────────────────────────────────────────────┘
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| **Telemetry Entry** | `Utils/telemetry.js` | Public API for emitting telemetry events |
| **Event Definitions** | `Utils/telemetryEvents.js` | Registry of valid telemetry event types |
| **Logger** | `Utils/logger.js` | Core telemetry buffering, flushing, and local logging |
| **Adapter Interface** | `adapters/telemetry/telemetryAdapter.js` | Vendor-neutral adapter abstraction |
| **Azure Adapter** | `adapters/telemetry/azureTelemetryAdapter.js` | Azure Monitor OpenTelemetry implementation |
| **Fallback** | `Utils/logger.js` (lines 13-36) | Legacy Application Insights support |

---

## Troubleshooting Checklist

### Phase 1: Pre-Flight Checks

#### 1.1 Verify Environment File

**Check:** `.env` file exists in project root

```bash
# Windows
dir .env

# Linux/Mac
ls -la .env
```

**Expected Result:** File exists

**If Missing:**
```bash
# Windows
copy .env.example .env

# Linux/Mac
cp .env.example .env
```

**Verification:**
- [ ] `.env` file created
- [ ] File contains required configuration sections

---

#### 1.2 Verify Dependencies Installed

**Check:** `node_modules` directory exists

```bash
# Windows
dir node_modules

# Linux/Mac
ls -la node_modules | head -20
```

**Expected Result:** Directory exists with telemetry packages

**If Missing:**
```bash
npm install
```

**Verification:**
- [ ] `node_modules` directory created
- [ ] `@azure/monitor-opentelemetry` present
- [ ] `@opentelemetry/sdk-trace-node` present
- [ ] `@opentelemetry/sdk-trace-base` present
- [ ] `@opentelemetry/api` present
- [ ] `applicationinsights` present

---

#### 1.3 Verify Telemetry Configuration

**Check:** Required environment variables set in `.env`

```bash
# View current .env settings
type .env  # Windows
cat .env   # Linux/Mac
```

**Required Variables:**
```env
# Enable telemetry
VOICEBOT_TELEMETRY=true

# Azure Monitor connection (preferred)
AZURE_MONITOR_CONNECTION_STRING=InstrumentationKey=YOUR_KEY;IngestionEndpoint=https://YOUR_REGION.in.applicationinsights.azure.com/

# OR Application Insights (legacy fallback)
APPINSIGHTS_CONNECTION_STRING=InstrumentationKey=YOUR_KEY;IngestionEndpoint=https://YOUR_REGION.in.applicationinsights.azure.com/
```

**How to Get Connection String:**
1. Navigate to Azure Portal
2. Open Application Insights resource
3. Go to "Overview" → "Essentials"
4. Copy "Connection String"

**Verification:**
- [ ] `VOICEBOT_TELEMETRY=true` set
- [ ] `AZURE_MONITOR_CONNECTION_STRING` set (preferred) OR `APPINSIGHTS_CONNECTION_STRING` set
- [ ] Connection string contains `InstrumentationKey`
- [ ] Connection string contains `IngestionEndpoint`

---

### Phase 2: Telemetry Agent Health

#### 2.1 Verify Telemetry Modules Load

**Check:** Run diagnostic script

```bash
node ci/scripts/diagnose-telemetry.js
```

**Expected Results:**
- ✅ Utils/telemetry.js exists
- ✅ Utils/telemetryEvents.js exists
- ✅ Utils/logger.js exists
- ✅ telemetryEvents module loaded successfully
- ✅ telemetryAdapter module loaded successfully
- ✅ azureTelemetryAdapter module loaded successfully

**If Failing:**
- Check file permissions
- Verify no syntax errors in files
- Ensure Node.js version compatible (>= 14.x)

**Verification:**
- [ ] All telemetry modules load without errors
- [ ] 23 telemetry events defined
- [ ] All critical events present

---

#### 2.2 Verify Telemetry Initialization

**Check:** Start application and monitor logs

```bash
npm start
```

**Expected Output:**
```
[Telemetry] Telemetry initialized
[Telemetry] Azure Monitor exporter configured
```

**If No Initialization Logs:**
- Check `VOICEBOT_TELEMETRY=true` in `.env`
- Verify connection string format
- Check for error messages in console

**Verification:**
- [ ] Application starts without telemetry errors
- [ ] Telemetry initialization logged
- [ ] Azure Monitor exporter configured

---

#### 2.3 Verify Logs Directory Created

**Check:** `logs` directory exists

```bash
# Windows
dir logs

# Linux/Mac
ls -la logs
```

**Expected Result:** Directory created with write permissions

**If Missing:**
- Directory will be created automatically on first emit
- Verify write permissions in project directory

**Verification:**
- [ ] `logs` directory exists
- [ ] Directory is writable
- [ ] `voicebot-events.jsonl` file created after first event

---

### Phase 3: Network Connectivity

#### 3.1 Test DNS Resolution

**Check:** Resolve Azure Monitor endpoint

```bash
# Extract endpoint from connection string
# Example: https://eastus2.in.applicationinsights.azure.com
nslookup eastus2.in.applicationinsights.azure.com
```

**Expected Result:** Resolves to Azure IP addresses

**If Failing:**
- Check DNS configuration
- Verify network connectivity
- Check firewall rules

**Verification:**
- [ ] DNS resolution successful
- [ ] Returns valid IP addresses

---

#### 3.2 Test TCP Connection

**Check:** Connect to Azure Monitor port 443

```bash
# Windows
powershell -Command "Test-NetConnection -ComputerName eastus2.in.applicationinsights.azure.com -Port 443"

# Linux/Mac
nc -zv eastus2.in.applicationinsights.azure.com 443
```

**Expected Result:** Connection successful

**If Failing:**
- Check firewall outbound rules
- Verify proxy configuration
- Check corporate network policies

**Verification:**
- [ ] TCP connection to port 443 successful
- [ ] No firewall blocking

---

#### 3.3 Test HTTPS Endpoint

**Check:** Make test request to Azure Monitor

```bash
# Using curl
curl -I https://eastus2.in.applicationinsights.azure.com/v2/track

# Using PowerShell
powershell -Command "Invoke-WebRequest -Uri 'https://eastus2.in.applicationinsights.azure.com/v2/track' -Method HEAD"
```

**Expected Result:** HTTP response (may be 401/403 due to auth, but should respond)

**If Failing:**
- Check SSL/TLS configuration
- Verify certificate chain
- Check proxy settings

**Verification:**
- [ ] HTTPS endpoint responds
- [ ] SSL certificate valid

---

#### 3.4 Verify Firewall Rules

**Check:** Outbound firewall rules allow telemetry

**Required Outbound Rules:**
- Protocol: HTTPS (TCP 443)
- Destination: `*.applicationinsights.azure.com`
- Destination: `*.monitor.azure.com`

**Windows Firewall:**
```powershell
# Check existing rules
Get-NetFirewallRule | Where-Object {$_.DisplayName -like "*Azure*"}

# Add rule if needed
New-NetFirewallRule -DisplayName "Allow Azure Monitor" -Direction Outbound -Protocol TCP -RemotePort 443 -Action Allow
```

**Linux iptables:**
```bash
# Check rules
sudo iptables -L -n | grep 443

# Add rule if needed
sudo iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT
```

**Verification:**
- [ ] Outbound HTTPS allowed to Azure domains
- [ ] No proxy blocking telemetry traffic

---

### Phase 4: Telemetry Data Generation

#### 4.1 Verify Event Definitions

**Check:** All required events defined

```bash
node -e "const EVENTS = require('./Utils/telemetryEvents'); console.log(Array.from(EVENTS));"
```

**Expected Events:**
1. mode_transition
2. turn_created
3. turn_snapshot
4. degradation_state_transition
5. carrier_jitter_sample
6. turn_interrupted
7. user_turn_completed
8. clarification_emitted
9. micro_ack_emitted
10. audio_buffer_received
11. tts_queue_depth
12. speech_started
13. speech_playback_started
14. speech_emitted
15. speech_cancelled
16. speech_completed
17. hangup_triggered
18. turn_closed
19. unlock_granted
20. user_speech_started
21. call-progress-events
22. pipeline_error
23. realtime_connection_closed

**Verification:**
- [ ] All 23 events defined
- [ ] No duplicate event names
- [ ] Event names are valid strings

---

#### 4.2 Verify Application Integration

**Check:** Telemetry imported and used in app.js

```bash
# Count telemetry.emit calls
grep -c "telemetry.emit" app.js
```

**Expected Result:** > 0 (currently 52 calls)

**If Zero:**
- Verify telemetry import: `const telemetry = require('./Utils/telemetry');`
- Check for syntax errors

**Verification:**
- [ ] Telemetry module imported
- [ ] Multiple emit() calls present
- [ ] Emit calls in critical code paths

---

#### 4.3 Test Event Emission

**Check:** Create test script to emit events

Create `test-telemetry.js`:
```javascript
const telemetry = require('./Utils/telemetry');

console.log('Testing telemetry emission...');

// Test basic event
telemetry.emit('mode_transition', {
  connectionId: 'test-connection-123',
  currentMode: 'INTERACTIVE',
  nextMode: 'DEGRADED',
  reason: 'test'
});

// Test turn event
telemetry.emit('turn_created', {
  connectionId: 'test-connection-123',
  turnId: 'test-turn-456',
  turnEpoch: 1
});

console.log('Events emitted. Waiting for flush...');
setTimeout(() => {
  console.log('Check logs/voicebot-events.jsonl for emitted events');
  process.exit(0);
}, 2000);
```

Run test:
```bash
node test-telemetry.js
```

**Verification:**
- [ ] Test script runs without errors
- [ ] Events appear in logs/voicebot-events.jsonl
- [ ] Events have correct structure (timestamp, eventType, payload)

---

### Phase 5: Data Transmission

#### 5.1 Verify Local Log File

**Check:** Telemetry events written to local file

```bash
# Check log file exists
dir logs\voicebot-events.jsonl

# View recent events
type logs\voicebot-events.jsonl | more

# Count events
find /c /v "" logs\voicebot-events.jsonl
```

**Expected Result:** File exists with JSONL-formatted events

**If File Empty:**
- Verify telemetry enabled
- Check for emit() calls
- Verify flush interval (1000ms)

**Verification:**
- [ ] Log file exists
- [ ] File contains valid JSON lines
- [ ] Events have timestamp, eventType, callId, turnId, payload
- [ ] File size growing over time

---

#### 5.2 Verify Buffer Management

**Check:** Event buffering and flushing

**Configuration:**
- Max buffer size: 1000 events
- Flush interval: 1000ms
- Max batch size: 512 events
- Max file size: 50MB

**Monitor Buffer:**
```javascript
// Add to logger.js temporarily for debugging
console.log('[Buffer] Size:', runtimeState.buffer.length);
console.log('[Buffer] Dropped:', runtimeState.droppedEvents);
```

**Expected Behavior:**
- Events buffered until flush interval
- Flush writes to file and sends to Azure
- Critical events (lifecycle) take priority when buffer full

**Verification:**
- [ ] Buffer size stays below 1000
- [ ] Flush occurs every ~1000ms
- [ ] No events dropped under normal load
- [ ] Critical events never dropped

---

#### 5.3 Verify Azure Transmission

**Check:** Events sent to Azure Monitor

**Method 1: Check Azure Portal**
1. Navigate to Application Insights resource
2. Go to "Logs" (Kusto)
3. Run query:
```kusto
customEvents
| where timestamp >= ago(1h)
| order by timestamp desc
| take 10
```

**Method 2: Check Network Traffic**
```bash
# Windows - Use Network Monitor or Wireshark
# Filter for: host contains "applicationinsights.azure.com"

# Linux/Mac
tcpdump -i any host applicationinsights.azure.com
```

**Expected Result:** Events appear in Azure Monitor

**If Not Appearing:**
- Check connection string validity
- Verify network connectivity
- Check for export errors in console
- Verify InstrumentationKey matches resource

**Verification:**
- [ ] Events visible in Azure Monitor
- [ ] Events appear within 1-2 minutes of emission
- [ ] Event data matches local logs
- [ ] No export errors in console

---

### Phase 6: Monitoring Dashboard

#### 6.1 Verify Dashboard Configuration

**Check:** Azure Monitor dashboard configured

**Steps:**
1. Navigate to Application Insights in Azure Portal
2. Go to "Overview"
3. Verify charts are updating:
   - Server response time
   - Server requests
   - Failed requests
   - Custom events

**Expected Result:** Charts show telemetry data

**If Charts Empty:**
- Verify connection string matches resource
- Check time range filters
- Verify events being emitted

**Verification:**
- [ ] Dashboard accessible
- [ ] Charts updating with real-time data
- [ ] Custom events visible
- [ ] No data gaps

---

#### 6.2 Create Custom Dashboard

**Check:** Custom telemetry dashboard for VoiceBot

**Recommended Queries:**

**Call Timeline:**
```kusto
customEvents
| where name == "hangup_triggered"
| project timestamp, callId = customDimensions.callId, duration = customDimensions.duration
| order by timestamp desc
```

**Turn Analysis:**
```kusto
customEvents
| where name in ("turn_created", "turn_closed")
| project timestamp, name, callId = customDimensions.callId, turnId = customDimensions.turnId
| order by timestamp, callId
```

**Speech Lifecycle:**
```kusto
customEvents
| where name in ("speech_started", "speech_emitted", "speech_completed")
| project timestamp, name, callId = customDimensions.connectionId
| order by timestamp desc
```

**Carrier Quality:**
```kusto
customEvents
| where name == "behavior_drift_detected"
| project timestamp, callId = customDimensions.callId, 
  carrierQualityScore = customDimensions.carrierQualityScore,
  driftFlags = customDimensions.driftFlags
| order by timestamp desc
```

**Verification:**
- [ ] Custom queries return data
- [ ] Dashboard panels created
- [ ] Real-time monitoring functional
- [ ] Alerts configured (optional)

---

#### 6.3 Verify Data Visibility

**Check:** End-to-end data flow verification

**Test Procedure:**
1. Start application with telemetry enabled
2. Make a test call (or simulate)
3. Wait 2-3 minutes for data propagation
4. Check local log file
5. Check Azure Monitor dashboard

**Expected Results:**
- Local log file: Events present immediately
- Azure Monitor: Events appear within 1-2 minutes
- Dashboard: Charts update with new data

**Verification:**
- [ ] Local logs contain test events
- [ ] Azure Monitor shows test events
- [ ] Dashboard reflects test data
- [ ] End-to-end latency < 2 minutes

---

## Common Issues and Solutions

### Issue 1: Telemetry Not Enabled

**Symptoms:**
- No telemetry events in logs
- No data in Azure Monitor
- Application runs but no telemetry output

**Diagnosis:**
```bash
# Check environment variable
echo %VOICEBOT_TELEMETRY%
```

**Solution:**
```env
# Add to .env
VOICEBOT_TELEMETRY=true
```

---

### Issue 2: Connection String Invalid

**Symptoms:**
- "Azure telemetry initialization failed" error
- Events in local logs but not in Azure Monitor
- Network connectivity tests fail

**Diagnosis:**
```bash
# Check connection string format
echo %AZURE_MONITOR_CONNECTION_STRING%
```

**Solution:**
- Verify connection string from Azure Portal
- Ensure format: `InstrumentationKey=xxx;IngestionEndpoint=https://xxx`
- Test with simple Node.js script

---

### Issue 3: Network Blocked

**Symptoms:**
- DNS resolution fails
- TCP connection times out
- Firewall blocks outbound HTTPS

**Diagnosis:**
```bash
# Test connectivity
nslookup eastus2.in.applicationinsights.azure.com
curl -I https://eastus2.in.applicationinsights.azure.com/v2/track
```

**Solution:**
- Configure firewall rules
- Set up proxy if required
- Check corporate network policies

---

### Issue 4: Events Dropped

**Symptoms:**
- "Dropped events" warning in console
- Missing events in timeline
- Incomplete call data

**Diagnosis:**
- Check buffer overflow in logs
- Monitor event rate
- Review critical event prioritization

**Solution:**
- Reduce event emission rate
- Increase buffer size (if needed)
- Prioritize critical events

---

### Issue 5: Data Not Appearing in Dashboard

**Symptoms:**
- Local logs show events
- Network connectivity OK
- Azure Monitor empty

**Diagnosis:**
- Verify InstrumentationKey matches resource
- Check time range filters
- Verify resource region

**Solution:**
- Confirm correct Application Insights resource
- Update connection string
- Check resource status in Azure Portal

---

## Diagnostic Script Usage

### Running the Full Diagnostic

```bash
node ci/scripts/diagnose-telemetry.js
```

### Expected Output Sections

1. **Configuration Verification** - Environment variables and files
2. **Dependency Verification** - Package installation status
3. **Telemetry Agent Initialization** - Module loading status
4. **Network Connectivity** - DNS, TCP, HTTPS tests
5. **System Logs** - Log directory and file status
6. **Telemetry Data Generation** - Event definitions and emit function
7. **Application Integration** - Import and usage in app.js
8. **Summary** - Pass/fail counts and recommendations

### Interpreting Results

| Result | Action Required |
|--------|-----------------|
| ✅ Passed | No action needed |
| ⚠ Warning | Monitor, may need attention |
| ❌ Failed | Immediate action required |

---

## Monitoring and Maintenance

### Regular Checks

**Daily:**
- [ ] Verify telemetry events appearing in Azure Monitor
- [ ] Check for error logs in console
- [ ] Monitor buffer overflow warnings

**Weekly:**
- [ ] Review telemetry data quality
- [ ] Check for data gaps
- [ ] Verify dashboard accuracy

**Monthly:**
- [ ] Review and update event definitions
- [ ] Optimize event emission rate
- [ ] Review Azure Monitor costs

### Performance Optimization

**Reduce Event Volume:**
- Sample high-frequency events (e.g., carrier_jitter_sample)
- Aggregate metrics before emission
- Filter debug events in production

**Improve Latency:**
- Reduce flush interval (currently 1000ms)
- Increase batch size (currently 512)
- Optimize network connection

**Reduce Costs:**
- Filter non-critical events
- Use sampling for high-volume events
- Review Azure Monitor pricing tier

---

## Security Considerations

### Connection String Security

**Best Practices:**
- Never commit `.env` to version control
- Use Azure Key Vault for production
- Rotate connection strings regularly
- Use least-privilege access

### Data Privacy

**Considerations:**
- Review what data is sent in payloads
- Sanitize sensitive information before emission
- Comply with data protection regulations (GDPR, CCPA)
- Implement data retention policies

### Network Security

**Recommendations:**
- Use HTTPS for all telemetry transmission
- Implement TLS certificate validation
- Monitor for suspicious telemetry patterns
- Set up alerts for unusual activity

---

## Appendix A: Quick Reference

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VOICEBOT_TELEMETRY` | Yes | `false` | Enable/disable telemetry |
| `AZURE_MONITOR_CONNECTION_STRING` | Yes* | - | Azure Monitor connection string |
| `APPINSIGHTS_CONNECTION_STRING` | No | - | Legacy App Insights fallback |

*Preferred over APPINSIGHTS_CONNECTION_STRING

### File Locations

| File | Purpose |
|------|---------|
| `.env` | Environment configuration |
| `Utils/telemetry.js` | Telemetry API |
| `Utils/telemetryEvents.js` | Event definitions |
| `Utils/logger.js` | Core logger |
| `adapters/telemetry/telemetryAdapter.js` | Adapter interface |
| `adapters/telemetry/azureTelemetryAdapter.js` | Azure implementation |
| `logs/voicebot-events.jsonl` | Local event log |

### Configuration Constants

| Setting | Value | Location |
|---------|-------|----------|
| Max Buffer Size | 1000 events | `Utils/logger.js:42` |
| Flush Interval | 1000ms | `Utils/logger.js:43` |
| Max Batch Size | 512 events | `adapters/telemetry/azureTelemetryAdapter.js:49` |
| Max File Size | 50MB | `Utils/logger.js:44` |
| Timeline Limit | 200 events | `Utils/logger.js:57` |

---

## Appendix B: Troubleshooting Commands

### Windows Commands

```batch
REM Check environment variables
set VOICEBOT_TELEMETRY
set AZURE_MONITOR_CONNECTION_STRING

REM Test DNS
nslookup eastus2.in.applicationinsights.azure.com

REM Test TCP connection
powershell -Command "Test-NetConnection -ComputerName eastus2.in.applicationinsights.azure.com -Port 443"

REM Check log files
dir logs
type logs\voicebot-events.jsonl | findstr /C:"eventType"

REM Count events
find /c /v "" logs\voicebot-events.jsonl
```

### Linux/Mac Commands

```bash
# Check environment variables
echo $VOICEBOT_TELEMETRY
echo $AZURE_MONITOR_CONNECTION_STRING

# Test DNS
nslookup eastus2.in.applicationinsights.azure.com
dig eastus2.in.applicationinsights.azure.com

# Test TCP connection
nc -zv eastus2.in.applicationinsights.azure.com 443
telnet eastus2.in.applicationinsights.azure.com 443

# Check log files
ls -la logs/
tail -f logs/voicebot-events.jsonl

# Count events
wc -l logs/voicebot-events.jsonl

# Search for specific events
grep "speech_started" logs/voicebot-events.jsonl | jq
```

---

## Appendix C: Contact and Support

### Internal Resources

- **Documentation:** `docs/` directory
- **Configuration:** `.env.example`
- **Diagnostic Script:** `ci/scripts/diagnose-telemetry.js`

### External Resources

- **Azure Monitor Documentation:** https://docs.microsoft.com/azure/azure-monitor/
- **OpenTelemetry Documentation:** https://opentelemetry.io/docs/
- **Application Insights SDK:** https://github.com/microsoft/ApplicationInsights-node.js

### Getting Help

1. Run diagnostic script: `node ci/scripts/diagnose-telemetry.js`
2. Review this troubleshooting checklist
3. Check Azure Portal for resource status
4. Contact Azure Support if issues persist

---

## Change Log

| Date | Version | Changes |
|------|---------|---------|
| 2026-03-10 | 1.0 | Initial comprehensive diagnostic analysis and troubleshooting guide |

---

**Document Status:** ✅ Complete  
**Last Review:** 2026-03-10  
**Next Review:** 2026-04-10

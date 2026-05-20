'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const originalConsoleLog = console.log;
console.log = () => {};
const BaseRealtimeAdapter = require('../adapters/ai/BaseRealtimeAdapter');
const telemetry = require('../Utils/telemetry');
console.log = originalConsoleLog;

const DEFAULT_OUT_LOG = '/Users/divyanggarg/Downloads/voicebot-out 82.log';
const DEFAULT_ERROR_LOG = '/Users/divyanggarg/Downloads/voicebot-error 36.log';
const DUPLICATE_SYNTHESIS_EVENTS = new Set([
    'response_duplicate_suppressed',
    'synthesis_gate_failed',
    'synthesis_gate_cap_reached',
    'early_duplicate_cancelled',
    'response_quality_fail'
]);
const RECOVERY_CLASS_EVENTS = new Set([
    'barge_in_recovery',
    'barge_in_recovery_clarification_sent',
    'silence_nudge_scripted_sent',
    'response_duplicate_suppressed',
    'synthesis_gate_failed',
    'synthesis_gate_cap_reached',
    'early_duplicate_cancelled',
    'response_quality_fail',
    'stale_recovery_response_dropped',
    'response_timeout',
    'response_create_retry_after_done'
]);
const SPEECH_BOUNDARY_EVENTS = new Set(['speech_started', 'speech_stopped', 'user_transcribed']);
const DEFAULT_ASSERTION_THRESHOLDS = Object.freeze({
    unsafeBargeInRecoveryNudges: 0,
    recoveryBeforeTranscript: 0,
    maxRecoveryResponsesPerTurn: 3,
    maxDuplicateSynthesisEventsPerTurn: 3,
    speechWindowNoTranscript: 0,
    assistantWeatherMentions: null,
    minBookingIntentCaptureRate: null
});
const DUPLICATE_SYNTHESIS_CHAIN_GAP_MS = 8000;
const ASSISTANT_WEATHER_PATTERN = /\b(weather|nice\s+weather|forecast|rain|raining|sunny|snow|wetter)\b/i;

function summarizeText(value) {
    const text = String(value || '');
    const trimmed = text.trim();
    return {
        hash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12),
        length: text.length,
        wordCount: trimmed ? trimmed.split(/\s+/).length : 0
    };
}

function assistantText(row) {
    if (!row || row.event !== 'ai_response') return '';
    return String(row.transcript || row.text || row.response || '');
}

function parseLine(line) {
    try {
        const outer = JSON.parse(line);
        const row = {
            outerTs: outer.ts,
            message: outer.message,
            data: outer.data,
            raw: line
        };
        if (typeof outer.message === 'string' && outer.message.startsWith('{')) {
            try { Object.assign(row, JSON.parse(outer.message)); } catch (_) {}
        }
        return row;
    } catch (_) {
        return { message: line, raw: line };
    }
}

function toMs(row) {
    if (typeof row.ts === 'number') return row.ts;
    if (typeof row.outerTs === 'string') {
        const value = Date.parse(row.outerTs);
        if (!Number.isNaN(value)) return value;
    }
    return null;
}

function transcriptLength(row) {
    const value = String(row.transcript || '');
    const match = value.match(/length=(\d+)/);
    if (match) return Number(match[1]);
    return value.length || 1;
}

function readRows(filePath) {
    return fs.readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map(parseLine)
        .map((row) => ({ ...row, ms: toMs(row) }))
        .filter((row) => row.ms != null);
}

function groupCalls(rows) {
    const calls = new Map();
    for (const row of rows) {
        let callId = row.callSID || row.callId || null;
        if (!callId && Array.isArray(row.data) && row.data[0] && typeof row.data[0] === 'object') {
            callId = row.data[0].callSID || null;
        }
        if (!callId || callId === 'none') continue;
        if (!calls.has(callId)) calls.set(callId, []);
        calls.get(callId).push(row);
    }
    return calls;
}

function gatePayload(row) {
    return Array.isArray(row.data) && row.data[0] && typeof row.data[0] === 'object'
        ? row.data[0]
        : null;
}

function extractConnectionIds(rows) {
    const ids = new Set();
    for (const row of rows) {
        const gate = gatePayload(row);
        if (gate?.connectionId) ids.add(gate.connectionId);
        const match = String(row.message || '').match(/\[plivo:([^\]]+)\]/);
        if (match) ids.add(match[1]);
    }
    return [...ids];
}

function summarizePhase3Warnings(rows) {
    const byConnection = new Map();
    for (const row of rows) {
        const match = String(row.message || '').match(/\[Phase3\]\[plivo:([^\]]+)\] MA cancelled \(([^)]+)\)/);
        if (!match) continue;
        const [, connectionId, reason] = match;
        if (!byConnection.has(connectionId)) byConnection.set(connectionId, {});
        const reasons = byConnection.get(connectionId);
        reasons[reason] = (reasons[reason] || 0) + 1;
    }
    return byConnection;
}

function isGateRow(row) {
    return row.message === '[GateV2]' || row.message === '[GateV2 DROP]';
}

function isDroppedGate(row, gate) {
    return row.message === '[GateV2 DROP]' || gate.send === false;
}

function nextSpeechBoundaryIndex(rows, index) {
    for (let i = index + 1; i < rows.length; i += 1) {
        if (SPEECH_BOUNDARY_EVENTS.has(rows[i].event)) return i;
    }
    return rows.length;
}

function hasRecoveryNudgeBeforeBoundary(rows, recoveryIndex) {
    const boundaryIndex = nextSpeechBoundaryIndex(rows, recoveryIndex);
    for (let i = recoveryIndex + 1; i < boundaryIndex; i += 1) {
        if (rows[i].event === 'silence_nudge_scripted_sent') return rows[i];
    }
    return null;
}

function analyzeReplayAssertions(callId, rows) {
    const sorted = [...rows].sort((a, b) => a.ms - b.ms);
    const details = {
        unsafeBargeInRecoveryNudges: [],
        recoveryBeforeTranscript: [],
        duplicateSynthesisChains: [],
        assistantWeatherMentions: []
    };
    let duplicateSynthesisChains = 0;
    let recoveryEventsThisTurn = 0;
    let duplicateSynthesisEventsThisTurn = 0;
    let maxRecoveryResponsesPerTurn = 0;
    let maxDuplicateSynthesisEventsPerTurn = 0;
    let duplicateSynthesisChainOpen = false;
    let lastDuplicateSynthesisAt = 0;
    let currentTurnIndex = 0;
    let bookingIntentDetectedCount = 0;
    let bookingLinkRequestedCount = 0;
    let bookingLinkSentCount = 0;
    let assistantWeatherMentions = 0;

    const closeTurn = () => {
        maxRecoveryResponsesPerTurn = Math.max(maxRecoveryResponsesPerTurn, recoveryEventsThisTurn);
        maxDuplicateSynthesisEventsPerTurn = Math.max(maxDuplicateSynthesisEventsPerTurn, duplicateSynthesisEventsThisTurn);
        recoveryEventsThisTurn = 0;
        duplicateSynthesisEventsThisTurn = 0;
        duplicateSynthesisChainOpen = false;
        lastDuplicateSynthesisAt = 0;
    };

    for (let i = 0; i < sorted.length; i += 1) {
        const row = sorted[i];
        if (row.event === 'user_transcribed') {
            closeTurn();
            currentTurnIndex += 1;
        }

        if (row.event === 'booking_intent_detected') bookingIntentDetectedCount += 1;
        if (row.event === 'booking_link_requested') bookingLinkRequestedCount += 1;
        if (row.event === 'booking_link_sent') bookingLinkSentCount += 1;

        const text = assistantText(row);
        if (text && ASSISTANT_WEATHER_PATTERN.test(text)) {
            assistantWeatherMentions += 1;
            details.assistantWeatherMentions.push({
                atMs: row.ms,
                turnIndex: currentTurnIndex,
                summary: summarizeText(text)
            });
        }

        if (RECOVERY_CLASS_EVENTS.has(row.event)) {
            recoveryEventsThisTurn += 1;
        }

        if (row.event === 'barge_in_recovery' && row.status?.isUserSpeaking === true) {
            const unsafe = {
                atMs: row.ms,
                turnCount: row.status?.turnCount ?? null,
                msSinceSpeechStarted: row.status?.msSinceSpeechStarted ?? null,
                msSinceSpeechStopped: row.status?.msSinceSpeechStopped ?? null,
                msSinceLastTranscript: row.status?.msSinceLastTranscript ?? null,
                lastInputEnergy: row.status?.lastInputEnergy ?? null,
                lastGateSendAudio: row.status?.lastGateSendAudio ?? null,
                lastGateSilenceFrames: row.status?.lastGateSilenceFrames ?? null
            };
            details.unsafeBargeInRecoveryNudges.push(unsafe);

            const nudge = hasRecoveryNudgeBeforeBoundary(sorted, i);
            if (nudge) {
                details.recoveryBeforeTranscript.push({
                    ...unsafe,
                    nudgeAtMs: nudge.ms,
                    nudgeDelayMs: nudge.ms - row.ms
                });
            }
        }

        if (DUPLICATE_SYNTHESIS_EVENTS.has(row.event)) {
            duplicateSynthesisEventsThisTurn += 1;
            if (!duplicateSynthesisChainOpen || (row.ms - lastDuplicateSynthesisAt) > DUPLICATE_SYNTHESIS_CHAIN_GAP_MS) {
                duplicateSynthesisChains += 1;
                duplicateSynthesisChainOpen = true;
                details.duplicateSynthesisChains.push({
                    startsAtMs: row.ms,
                    event: row.event,
                    turnIndex: currentTurnIndex,
                    turnCount: row.status?.turnCount ?? null
                });
            }
            lastDuplicateSynthesisAt = row.ms;
        }
    }
    closeTurn();

    return {
        callId,
        unsafeBargeInRecoveryNudges: details.unsafeBargeInRecoveryNudges.length,
        recoveryBeforeTranscript: details.recoveryBeforeTranscript.length,
        duplicateSynthesisChains,
        maxRecoveryResponsesPerTurn,
        maxDuplicateSynthesisEventsPerTurn,
        bookingIntentDetectedCount,
        bookingLinkRequestedCount,
        bookingLinkSentCount,
        assistantWeatherMentions,
        details
    };
}

function summarizeReplayAssertions(simulations, thresholds = DEFAULT_ASSERTION_THRESHOLDS) {
    const effectiveThresholds = { ...DEFAULT_ASSERTION_THRESHOLDS, ...(thresholds || {}) };
    const totals = {
        unsafeBargeInRecoveryNudges: 0,
        recoveryBeforeTranscript: 0,
        duplicateSynthesisChains: 0,
        maxRecoveryResponsesPerTurn: 0,
        maxDuplicateSynthesisEventsPerTurn: 0,
        speechWindowNoTranscript: 0,
        bookingIntentDetectedCalls: 0,
        bookingLinkRequestedCalls: 0,
        bookingLinkSentCalls: 0,
        assistantWeatherMentions: 0
    };
    const calls = simulations.map((simulation) => {
        const replayAssertions = simulation.replayAssertions || simulation;
        const speechWindowNoTranscript = simulation.speechWindowNoTranscript || 0;
        const callSummary = {
            callId: replayAssertions.callId,
            unsafeBargeInRecoveryNudges: replayAssertions.unsafeBargeInRecoveryNudges || 0,
            recoveryBeforeTranscript: replayAssertions.recoveryBeforeTranscript || 0,
            duplicateSynthesisChains: replayAssertions.duplicateSynthesisChains || 0,
            maxRecoveryResponsesPerTurn: replayAssertions.maxRecoveryResponsesPerTurn || 0,
            maxDuplicateSynthesisEventsPerTurn: replayAssertions.maxDuplicateSynthesisEventsPerTurn || 0,
            bookingIntentDetectedCount: replayAssertions.bookingIntentDetectedCount || 0,
            bookingLinkRequestedCount: replayAssertions.bookingLinkRequestedCount || 0,
            bookingLinkSentCount: replayAssertions.bookingLinkSentCount || 0,
            assistantWeatherMentions: replayAssertions.assistantWeatherMentions || 0,
            speechWindowNoTranscript
        };
        totals.unsafeBargeInRecoveryNudges += callSummary.unsafeBargeInRecoveryNudges;
        totals.recoveryBeforeTranscript += callSummary.recoveryBeforeTranscript;
        totals.duplicateSynthesisChains += callSummary.duplicateSynthesisChains;
        totals.maxRecoveryResponsesPerTurn = Math.max(totals.maxRecoveryResponsesPerTurn, callSummary.maxRecoveryResponsesPerTurn);
        totals.maxDuplicateSynthesisEventsPerTurn = Math.max(totals.maxDuplicateSynthesisEventsPerTurn, callSummary.maxDuplicateSynthesisEventsPerTurn);
        totals.speechWindowNoTranscript += callSummary.speechWindowNoTranscript;
        totals.assistantWeatherMentions += callSummary.assistantWeatherMentions;
        if (callSummary.bookingIntentDetectedCount > 0) totals.bookingIntentDetectedCalls += 1;
        if (callSummary.bookingLinkRequestedCount > 0) totals.bookingLinkRequestedCalls += 1;
        if (callSummary.bookingLinkSentCount > 0) totals.bookingLinkSentCalls += 1;
        const bookingIntentCaptureRate = callSummary.bookingIntentDetectedCount > 0
            ? Number((callSummary.bookingLinkRequestedCount / callSummary.bookingIntentDetectedCount).toFixed(4))
            : null;
        const bookingCapturePass = effectiveThresholds.minBookingIntentCaptureRate == null
            || (bookingIntentCaptureRate != null && bookingIntentCaptureRate >= effectiveThresholds.minBookingIntentCaptureRate);
        const weatherPass = effectiveThresholds.assistantWeatherMentions == null
            || callSummary.assistantWeatherMentions <= effectiveThresholds.assistantWeatherMentions;
        return {
            ...callSummary,
            bookingIntentCaptureRate,
            pass: callSummary.unsafeBargeInRecoveryNudges <= effectiveThresholds.unsafeBargeInRecoveryNudges
                && callSummary.recoveryBeforeTranscript <= effectiveThresholds.recoveryBeforeTranscript
                && callSummary.maxRecoveryResponsesPerTurn <= effectiveThresholds.maxRecoveryResponsesPerTurn
                && callSummary.maxDuplicateSynthesisEventsPerTurn <= effectiveThresholds.maxDuplicateSynthesisEventsPerTurn
                && callSummary.speechWindowNoTranscript <= effectiveThresholds.speechWindowNoTranscript
                && bookingCapturePass
                && weatherPass
        };
    });

    const bookingIntentCaptureRate = totals.bookingIntentDetectedCalls > 0
        ? Number((totals.bookingLinkRequestedCalls / totals.bookingIntentDetectedCalls).toFixed(4))
        : null;

    const checks = {
        unsafeBargeInRecoveryNudges: {
            pass: totals.unsafeBargeInRecoveryNudges <= effectiveThresholds.unsafeBargeInRecoveryNudges,
            actual: totals.unsafeBargeInRecoveryNudges,
            expectedMax: effectiveThresholds.unsafeBargeInRecoveryNudges
        },
        recoveryBeforeTranscript: {
            pass: totals.recoveryBeforeTranscript <= effectiveThresholds.recoveryBeforeTranscript,
            actual: totals.recoveryBeforeTranscript,
            expectedMax: effectiveThresholds.recoveryBeforeTranscript
        },
        duplicateSynthesisChains: {
            pass: totals.maxDuplicateSynthesisEventsPerTurn <= effectiveThresholds.maxDuplicateSynthesisEventsPerTurn,
            actual: totals.duplicateSynthesisChains,
            maxEventsPerTurn: totals.maxDuplicateSynthesisEventsPerTurn,
            expectedMaxEventsPerTurn: effectiveThresholds.maxDuplicateSynthesisEventsPerTurn
        },
        maxRecoveryResponsesPerTurn: {
            pass: totals.maxRecoveryResponsesPerTurn <= effectiveThresholds.maxRecoveryResponsesPerTurn,
            actual: totals.maxRecoveryResponsesPerTurn,
            expectedMax: effectiveThresholds.maxRecoveryResponsesPerTurn
        },
        speechWindowNoTranscript: {
            pass: totals.speechWindowNoTranscript <= effectiveThresholds.speechWindowNoTranscript,
            actual: totals.speechWindowNoTranscript,
            expectedMax: effectiveThresholds.speechWindowNoTranscript
        },
        assistantWeatherMentions: {
            pass: effectiveThresholds.assistantWeatherMentions == null
                || totals.assistantWeatherMentions <= effectiveThresholds.assistantWeatherMentions,
            actual: totals.assistantWeatherMentions,
            expectedMax: effectiveThresholds.assistantWeatherMentions,
            note: effectiveThresholds.assistantWeatherMentions == null
                ? 'Informational metric; not part of replay hard-fail thresholds.'
                : undefined
        },
        bookingIntentCaptureRate: {
            pass: effectiveThresholds.minBookingIntentCaptureRate == null
                || (bookingIntentCaptureRate != null && bookingIntentCaptureRate >= effectiveThresholds.minBookingIntentCaptureRate),
            actual: bookingIntentCaptureRate,
            expectedMin: effectiveThresholds.minBookingIntentCaptureRate,
            note: effectiveThresholds.minBookingIntentCaptureRate == null
                ? 'Informational metric; not part of replay hard-fail thresholds.'
                : undefined
        }
    };

    return {
        pass: Object.values(checks).every((check) => check.pass),
        thresholds: effectiveThresholds,
        totals,
        checks,
        calls
    };
}

function withNow(ms, fn) {
    const originalNow = Date.now;
    Date.now = () => ms;
    try {
        return fn();
    } finally {
        Date.now = originalNow;
    }
}

function buildAdapter(callId, emitted) {
    const adapter = new BaseRealtimeAdapter({});
    adapter.callSID = callId;
    adapter.turnStateRef = { currentTurnId: `${callId}:opening` };
    adapter.SILENCE_RECENT_SPEECH_START_GRACE_MS = 1200;
    adapter.SILENCE_RECENT_GATE_FRAMES = 8;
    adapter.SILENCE_RECENT_INPUT_ENERGY = 0.015;
    adapter.SILENCE_RECENT_GATE_ACTIVITY_MS = 1200;
    adapter.SPEECH_WINDOW_TRANSCRIPT_TIMEOUT_MS = 2000;
    Object.defineProperty(adapter, 'providerName', { value: 'plivo', configurable: true });

    const originalEmit = telemetry.emit;
    telemetry.emit = (event, payload = {}) => {
        emitted.push({ event, payload });
        return true;
    };

    return { adapter, restore: () => { telemetry.emit = originalEmit; } };
}

function simulateCall(callId, rows, phase3WarningsByConnection) {
    const sorted = [...rows].sort((a, b) => a.ms - b.ms);
    const gates = sorted.filter(isGateRow).map((row) => ({ row, gate: gatePayload(row) })).filter((entry) => entry.gate);
    const dropped = gates.filter(({ row, gate }) => isDroppedGate(row, gate));
    const sent = gates.filter(({ gate }) => gate.send === true);
    const highDropped = dropped.filter(({ gate }) => typeof gate.energy === 'number' && gate.energy >= 0.015);
    const silenceTimers = sorted.filter((row) => row.event === 'silence_timer_fired');
    const emitted = [];
    const { adapter, restore } = buildAdapter(callId, emitted);
    const originalLog = console.log;
    console.log = () => {};

    let speechSeq = 0;
    const transcriptDelays = [];

    try {
        for (const row of sorted) {
            if (row.event === 'speech_started') {
                speechSeq += 1;
                adapter.turnStateRef.currentTurnId = `${callId}:speech:${speechSeq}`;
                withNow(row.ms, () => adapter._recordSpeechWindowStart(row.ms));
            } else if (row.event === 'speech_stopped') {
                withNow(row.ms, () => adapter._recordSpeechWindowStop(row.ms));
            } else if (row.event === 'user_transcribed') {
                const openWindow = [...adapter._speechWindows].reverse().find((window) => !window.transcribed && window.stoppedAt);
                if (openWindow && openWindow.stoppedAt) transcriptDelays.push(row.ms - openWindow.stoppedAt);
                const text = 'x'.repeat(Math.max(1, transcriptLength(row)));
                withNow(row.ms, () => adapter._markSpeechWindowTranscribed(text, row.confidence));
            }
        }

        const highDropReasons = {};
        for (const { row, gate } of highDropped) {
            withNow(row.ms, () => adapter.setEnergyMetrics({
                variance: gate.variance,
                slope: gate.slope,
                energy: gate.energy,
                gateLevel: gate.level,
                gateSendAudio: false,
                silenceFrames: gate.silenceFrames
            }));
            const reason = withNow(row.ms + 50, () => adapter._getSilenceSuppressionReason(adapter._getSilenceStatus(row.ms + 50))) || 'none';
            highDropReasons[reason] = (highDropReasons[reason] || 0) + 1;
        }

        const timerDecisions = silenceTimers.map((timer) => {
            const priorGate = [...gates].reverse().find(({ row }) => row.ms <= timer.ms);
            if (priorGate) {
                const gate = priorGate.gate;
                withNow(priorGate.row.ms, () => adapter.setEnergyMetrics({
                    variance: gate.variance,
                    slope: gate.slope,
                    energy: gate.energy,
                    gateLevel: gate.level,
                    gateSendAudio: !isDroppedGate(priorGate.row, gate),
                    silenceFrames: gate.silenceFrames
                }));
            }
            const reason = withNow(timer.ms, () => adapter._getSilenceSuppressionReason(adapter._getSilenceStatus(timer.ms)));
            return {
                atMs: timer.ms,
                turnCount: timer.status?.turnCount ?? null,
                logEnergy: timer.status?.lastInputEnergy ?? null,
                replayReason: reason || 'send_nudge'
            };
        });

        adapter._clearSpeechWindowTimers();

        const speechTranscribed = emitted.filter((item) => item.event === 'speech_window_transcribed');
        const speechMissed = emitted.filter((item) => item.event === 'speech_window_no_transcript');
        const staleHighDrop = highDropped[0]
            ? (() => {
                const { row, gate } = highDropped[0];
                withNow(row.ms, () => adapter.setEnergyMetrics({
                    variance: gate.variance,
                    slope: gate.slope,
                    energy: gate.energy,
                    gateLevel: gate.level,
                    gateSendAudio: false,
                    silenceFrames: gate.silenceFrames
                }));
                return withNow(row.ms + 1500, () => adapter._getSilenceSuppressionReason(adapter._getSilenceStatus(row.ms + 1500))) || 'send_nudge';
            })()
            : 'no_high_drop_sample';

        const connectionIds = extractConnectionIds(sorted);
        const phase3Cancellations = {};
        for (const connectionId of connectionIds) {
            Object.assign(phase3Cancellations, phase3WarningsByConnection.get(connectionId) || {});
        }
        const replayAssertions = analyzeReplayAssertions(callId, sorted);

        return {
            callId,
            connectionIds,
            phase3Cancellations,
            sampledGateFrames: gates.length,
            sampledSentFrames: sent.length,
            sampledDroppedFrames: dropped.length,
            sampledDropRatio: gates.length ? Number((dropped.length / gates.length).toFixed(3)) : 0,
            highEnergyDroppedFrames: highDropped.length,
            maxEnergy: Number(Math.max(0, ...gates.map(({ gate }) => gate.energy || 0)).toFixed(6)),
            highDropSuppressionReasons: highDropReasons,
            staleHighDropDecisionAfter1500ms: staleHighDrop,
            speechStarted: sorted.filter((row) => row.event === 'speech_started').length,
            speechStopped: sorted.filter((row) => row.event === 'speech_stopped').length,
            transcripts: sorted.filter((row) => row.event === 'user_transcribed').length,
            speechWindowTranscribed: speechTranscribed.length,
            speechWindowNoTranscript: speechMissed.length,
            maxTranscriptDelayMs: transcriptDelays.length ? Math.max(...transcriptDelays) : null,
            timerDecisions,
            replayAssertions
        };
    } finally {
        adapter._clearSpeechWindowTimers();
        restore();
        console.log = originalLog;
    }
}

function buildReplayReport(logPath = DEFAULT_OUT_LOG, errorLogPath = DEFAULT_ERROR_LOG) {
    const resolved = path.resolve(logPath);
    const resolvedError = path.resolve(errorLogPath);
    const rows = readRows(resolved);
    const errorRows = fs.existsSync(resolvedError) ? readRows(resolvedError) : [];
    const phase3WarningsByConnection = summarizePhase3Warnings(errorRows);
    const calls = groupCalls(rows);
    const results = [...calls.entries()].map(([callId, callRows]) => simulateCall(callId, callRows, phase3WarningsByConnection));

    return {
        logPath: resolved,
        errorLogPath: fs.existsSync(resolvedError) ? resolvedError : null,
        callCount: results.length,
        assertions: summarizeReplayAssertions(results),
        simulations: results
    };
}

function main() {
    const logPath = process.argv[2] || DEFAULT_OUT_LOG;
    const errorLogPath = process.argv[3] || DEFAULT_ERROR_LOG;
    console.log(JSON.stringify(buildReplayReport(logPath, errorLogPath), null, 2));
}

if (require.main === module) main();

module.exports = {
    DEFAULT_ASSERTION_THRESHOLDS,
    analyzeReplayAssertions,
    buildReplayReport,
    groupCalls,
    parseLine,
    readRows,
    simulateCall,
    summarizeReplayAssertions,
    toMs
};

'use strict';

const express = require('express');
const Router = express.Router();
const { apiAuth } = require('../middleware/auth');
const CXStateRegistry = require('../services/CXStateRegistry');
const { getPhase4Metrics } = require('../observability/phase4Metrics');
const { PROFILES } = require('../profiles/conversationProfiles');

// ── E1: CX Observability (read-only) ─────────────────────────────────

Router.get('/api/v2/calls/active', apiAuth, (req, res) => {
    res.json({ calls: CXStateRegistry.getActiveCalls() });
});

Router.get('/api/v2/calls/:callId/cx-state', apiAuth, (req, res) => {
    const entry = CXStateRegistry.get(req.params.callId);
    if (!entry) return res.status(404).json({ error: 'Call not found or ended' });

    const rs = entry.realtimeService;
    const ccs = entry.callContextState;

    res.json({
        callSID: entry.callSID,
        durationMs: Date.now() - entry.createdAt,
        conversationPhase: rs?.conversationPhase || 'unknown',
        turnCount: rs?.count || 0,
        degradationState: ccs?.degradationEngine?.getCurrentState?.() || 'NORMAL',
        stabilityMetrics: ccs?.degradationEngine?.getStabilityMetrics?.() || null,
        interactionMode: ccs?.interactionMode || null,
        clarificationCount: ccs?.clarificationCount || 0,
        phase4Profile: ccs?.phase4Profile?.name || null,
        userEmail: rs?.userEmail || null,
        preferredSlot: rs?.preferredSlot || null,
        packetLossRatio: entry.edgeSession?.packetLossRatio || 0,
        complexity: rs?._currentComplexity || 'simple'
    });
});

Router.get('/api/v2/calls/:callId/turns', apiAuth, (req, res) => {
    const entry = CXStateRegistry.get(req.params.callId);
    if (!entry) return res.status(404).json({ error: 'Call not found or ended' });

    const context = entry.realtimeService?.conversationContext || [];
    const turns = context.map((turn, i) => ({
        index: i,
        sender: turn.sender,
        preview: (turn.message || '').substring(0, 200),
        timestamp: turn.timestamp || null
    }));
    res.json({ callSID: entry.callSID, turns });
});

Router.get('/api/v2/cx/metrics', apiAuth, (req, res) => {
    res.json({ metrics: getPhase4Metrics() });
});

// ── E2: CX Configuration ────────────────────────────────────────────

Router.get('/api/v2/profiles', apiAuth, (req, res) => {
    const profiles = Object.entries(PROFILES).map(([name, p]) => ({
        name,
        rag: p.rag,
        intent: p.intent,
        escalation: p.escalation,
        transaction: p.transaction
    }));
    res.json({ profiles });
});

// ── E3: CX Control ──────────────────────────────────────────────────

Router.post('/api/v2/calls/:callId/escalate', apiAuth, (req, res) => {
    const entry = CXStateRegistry.get(req.params.callId);
    if (!entry) return res.status(404).json({ error: 'Call not found or ended' });

    entry.realtimeService?.setHandoverTriggered?.(true);
    entry.edgeSession?.emitSignal?.('signal_handover', {
        reason: 'api_forced_escalation'
    });

    res.json({ status: 'escalation_triggered', callSID: entry.callSID });
});

Router.post('/api/v2/calls/:callId/style-override', apiAuth, (req, res) => {
    const entry = CXStateRegistry.get(req.params.callId);
    if (!entry) return res.status(404).json({ error: 'Call not found or ended' });

    const { directive } = req.body || {};
    if (!directive || typeof directive !== 'string') {
        return res.status(400).json({ error: 'directive string required' });
    }

    entry.realtimeService?.setToneDirective?.(directive);
    res.json({ status: 'style_override_applied', callSID: entry.callSID });
});

module.exports = Router;

'use strict';

/**
 * CX State Registry — per-call CX state accessible from API routes.
 * Entries are created by createCallSession, deleted on ws close.
 * Keyed by callSID.
 */

class CXStateRegistry {
    constructor() {
        this._store = new Map();
        // Evict stale entries every 60s (guard against leaked ws-close)
        this._sweepInterval = setInterval(() => this._evictStale(), 60_000);
        if (this._sweepInterval.unref) this._sweepInterval.unref();
    }

    /** Max call lifetime (2 hours). Entries older than this are evicted. */
    static MAX_CALL_TTL_MS = 2 * 60 * 60 * 1000;

    register(callSID, refs) {
        this._store.set(callSID, {
            callSID,
            createdAt: Date.now(),
            ...refs
        });
    }

    get(callSID) {
        return this._store.get(callSID) || null;
    }

    delete(callSID) {
        this._store.delete(callSID);
    }

    getAll() {
        return Array.from(this._store.values());
    }

    getActiveCalls() {
        return this.getAll().map(entry => ({
            callSID: entry.callSID,
            createdAt: entry.createdAt,
            durationMs: Date.now() - entry.createdAt,
            phase: entry.realtimeService?.conversationPhase || 'unknown',
            degradationState: entry.callContextState?.degradationEngine?.getCurrentState?.() || 'NORMAL',
            turnCount: entry.realtimeService?.count || 0,
            persona: entry.realtimeService?.persona?.id || null,
            interactionMode: entry.callContextState?.interactionMode || null
        }));
    }

    _evictStale() {
        const now = Date.now();
        for (const [callSID, entry] of this._store) {
            if (now - entry.createdAt > CXStateRegistry.MAX_CALL_TTL_MS) {
                this._store.delete(callSID);
            }
        }
    }
}

module.exports = new CXStateRegistry();

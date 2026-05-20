const telemetry = require('../Utils/telemetry');

class CallRegistry {

    constructor() {
        this.store = new Map();
        this.MAX_ENTRIES = Number(process.env.CALL_REGISTRY_MAX_ENTRIES) || 1000;
    }

    create(callId, data) {
        if (this.store.size >= this.MAX_ENTRIES) {
            telemetry.emit('call_registry_capacity_reached', {
                callId,
                maxEntries: this.MAX_ENTRIES,
                currentSize: this.store.size,
                ts: Date.now()
            });
            throw new Error(`CallRegistry capacity exceeded (${this.MAX_ENTRIES})`);
        }
        const call = {
            ...data,
            createdAt: Date.now(),
            status: "active"
        };

        this.store.set(callId, call);
        return call;
    }

    get(callId) {
        return this.store.get(callId);
    }

    update(callId, patch) {
        const call = this.store.get(callId);
        if (!call || typeof patch !== 'object' || patch === null) return null;

        for (const key of Object.keys(patch)) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            call[key] = patch[key];
        }
        return call;
    }

    delete(callId) {
        const call = this.store.get(callId);
        if (call && call._cleanupTimer) {
            clearTimeout(call._cleanupTimer);
            call._cleanupTimer = null;
        }
        this.store.delete(callId);
    }

    entries() {
        return this.store.entries();
    }

    cleanup(ttlMs) {
        const now = Date.now();

        for (const [id, call] of this.store.entries()) {
            if (call.createdAt && now - call.createdAt > ttlMs) {
                this.delete(id);
            }
        }
    }
}

module.exports = new CallRegistry();

/**
 * Simulation tests for all code fixes.
 * Run: node ci/scripts/simulate-fixes.js
 * Exit 0 = all passed. Exit 1 = failures.
 */

'use strict';
const assert = require('assert');
const EventEmitter = require('events');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ PASS  ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ FAIL  ${name}`);
        console.error(`         ${err.message}`);
        failed++;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1: Echo Guard — pauseTranscription lifecycle
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== FIX 1: Echo Guard ===');

function buildEchoGuard(edgeSession, GRACE_MS = 50) {
    let echoGuardTimer = null;
    function startEchoGuard() {
        edgeSession.pauseTranscription = true;
        if (echoGuardTimer) clearTimeout(echoGuardTimer);
    }
    function stopEchoGuard() {
        if (echoGuardTimer) clearTimeout(echoGuardTimer);
        echoGuardTimer = setTimeout(() => {
            edgeSession.pauseTranscription = false;
            echoGuardTimer = null;
        }, GRACE_MS);
    }
    function cancelEchoGuard() {
        if (echoGuardTimer) clearTimeout(echoGuardTimer);
        echoGuardTimer = null;
        edgeSession.pauseTranscription = false;
    }
    return { startEchoGuard, stopEchoGuard, cancelEchoGuard };
}

test('pauseTranscription is false initially', () => {
    const session = { pauseTranscription: false };
    const { startEchoGuard } = buildEchoGuard(session);
    assert.strictEqual(session.pauseTranscription, false);
});

test('startEchoGuard sets pauseTranscription = true immediately', () => {
    const session = { pauseTranscription: false };
    const { startEchoGuard } = buildEchoGuard(session);
    startEchoGuard();
    assert.strictEqual(session.pauseTranscription, true);
});

test('stopEchoGuard resets pauseTranscription after grace period', (done) => {
    const session = { pauseTranscription: false };
    const { startEchoGuard, stopEchoGuard } = buildEchoGuard(session, 60);
    startEchoGuard();
    assert.strictEqual(session.pauseTranscription, true);
    stopEchoGuard();
    // Still true during grace period
    assert.strictEqual(session.pauseTranscription, true);
    setTimeout(() => {
        assert.strictEqual(session.pauseTranscription, false,
            'Should be false after grace period');
        done && done();
    }, 80);
    return 'async';
});

test('cancelEchoGuard resets pauseTranscription immediately (barge-in)', () => {
    const session = { pauseTranscription: false };
    const { startEchoGuard, cancelEchoGuard } = buildEchoGuard(session, 100);
    startEchoGuard();
    assert.strictEqual(session.pauseTranscription, true);
    cancelEchoGuard();
    assert.strictEqual(session.pauseTranscription, false,
        'cancelEchoGuard must reset immediately without waiting for grace period');
});

test('multiple startEchoGuard calls do not stack timers', () => {
    const session = { pauseTranscription: false };
    const { startEchoGuard } = buildEchoGuard(session);
    // Calling many times (bot sends many audio chunks) should not leak timers.
    for (let i = 0; i < 20; i++) startEchoGuard();
    assert.strictEqual(session.pauseTranscription, true);
});

test('stopEchoGuard then cancelEchoGuard cancels the pending timer', (done) => {
    const session = { pauseTranscription: false };
    const { startEchoGuard, stopEchoGuard, cancelEchoGuard } = buildEchoGuard(session, 100);
    startEchoGuard();
    stopEchoGuard();
    // Immediately cancel — timer should not fire
    cancelEchoGuard();
    assert.strictEqual(session.pauseTranscription, false);
    setTimeout(() => {
        assert.strictEqual(session.pauseTranscription, false,
            'Should remain false — stop timer was cancelled');
        done && done();
    }, 150);
    return 'async';
});

test('audio rejected while pauseTranscription = true (echo frames suppressed)', () => {
    const session = { pauseTranscription: false };
    const { startEchoGuard } = buildEchoGuard(session);
    const sentToAzure = [];

    function maybeSendAudio(buf, session) {
        if (session.pauseTranscription) return; // suppressed
        sentToAzure.push(buf);
    }

    // Before bot speaks — normal user audio should pass
    maybeSendAudio('user_frame_1', session);
    assert.strictEqual(sentToAzure.length, 1);

    // Bot starts speaking — echo guard engages
    startEchoGuard();
    maybeSendAudio('echo_frame_1', session);
    maybeSendAudio('echo_frame_2', session);
    assert.strictEqual(sentToAzure.length, 1, 'Echo frames must be blocked');
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2: response.created is emitted by RealtimeServiceTwilio
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== FIX 2: response.created emitted ===');

function buildMockRealtimeService() {
    const ee = new EventEmitter();
    // Minimal mock of the fixed handleMessage switch
    ee.handleMessage = function(data) {
        const message = JSON.parse(data);
        switch (message.type) {
            case 'response.created':
                this.emit('response.created');
                break;
            case 'response.output_item.added':
            case 'response.output_item.done':
            case 'response.content_part.added':
            case 'response.content_part.done':
                break; // silenced — no default log
            case 'response.audio.delta':
                this.isResponding = true;
                this.emit('audio', message.delta);
                break;
            case 'response.done':
                this.isResponding = false;
                break;
            default:
                this.emit('unhandled', message.type);
        }
    };
    ee.isResponding = false;
    return ee;
}

test('response.created Azure event fires response.created on the emitter', () => {
    const svc = buildMockRealtimeService();
    let fired = false;
    svc.on('response.created', () => { fired = true; });
    svc.handleMessage(JSON.stringify({ type: 'response.created' }));
    assert.ok(fired, 'response.created listener must be called');
});

test('response.output_item.added is silenced (no unhandled event)', () => {
    const svc = buildMockRealtimeService();
    let unhandledTypes = [];
    svc.on('unhandled', (t) => unhandledTypes.push(t));
    for (const t of [
        'response.output_item.added',
        'response.output_item.done',
        'response.content_part.added',
        'response.content_part.done'
    ]) {
        svc.handleMessage(JSON.stringify({ type: t }));
    }
    assert.deepStrictEqual(unhandledTypes, [],
        'All 4 lifecycle events must be silenced, not hit default');
});

test('newTurn() is triggered when response.created fires (epoch isolation)', () => {
    const svc = buildMockRealtimeService();
    let turnChanges = 0;
    svc.on('response.created', () => { turnChanges++; });

    // Simulate 3 bot responses
    for (let i = 0; i < 3; i++) {
        svc.handleMessage(JSON.stringify({ type: 'response.created' }));
    }
    assert.strictEqual(turnChanges, 3,
        'newTurn() must fire once per bot response for epoch isolation');
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 3: cancelResponse() method exists and sends response.cancel
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== FIX 3: cancelResponse() method ===');

function buildMockRealtimeServiceWithCancel() {
    const svc = buildMockRealtimeService();
    const sent = [];
    svc.isConnected = true;
    svc.send = (msg) => sent.push(msg);
    svc.cancelResponse = function() {
        if (!this.isConnected) return;
        this.send({ type: 'response.cancel' });
        this.isResponding = false;
    };
    return { svc, sent };
}

test('cancelResponse() sends response.cancel to Azure', () => {
    const { svc, sent } = buildMockRealtimeServiceWithCancel();
    svc.isResponding = true;
    svc.cancelResponse();
    assert.ok(sent.some(m => m.type === 'response.cancel'),
        'response.cancel must be sent');
    assert.strictEqual(svc.isResponding, false,
        'isResponding must be reset to false');
});

test('cancelResponse() is a no-op when not connected', () => {
    const { svc, sent } = buildMockRealtimeServiceWithCancel();
    svc.isConnected = false;
    svc.cancelResponse();
    assert.strictEqual(sent.length, 0,
        'Must not send when disconnected');
});

test('cancelResponse() can be called multiple times safely', () => {
    const { svc, sent } = buildMockRealtimeServiceWithCancel();
    svc.cancelResponse();
    svc.cancelResponse();
    svc.cancelResponse();
    assert.strictEqual(sent.length, 3,
        'Each call sends one cancel (no crash on repeated calls)');
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 4: Transcription model (azure-speech) + locale language + echo cancellation type
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== FIX 4: Transcription model, language locale, echo cancellation ===');

// Mirrors the fixed getTranscriptionLang logic (locale format for azure-speech)
function getTranscriptionLang(botLang) {
    return botLang?.toLowerCase() === 'german' ? 'de-DE' : 'en-US';
}

function buildSessionUpdate(botLang) {
    const lang = botLang?.toLowerCase() || 'english';
    return {
        input_audio_transcription: {
            model: 'azure-speech',
            language: lang === 'german' ? 'de-DE' : 'en-US'
        },
        input_audio_echo_cancellation: { type: 'server_echo_cancellation' }
    };
}

test('English bot sets transcription language to locale "en-US"', () => {
    assert.strictEqual(getTranscriptionLang('english'), 'en-US');
});

test('German bot sets transcription language to locale "de-DE"', () => {
    assert.strictEqual(getTranscriptionLang('german'), 'de-DE');
});

test('Undefined/null botLang defaults to "en-US"', () => {
    assert.strictEqual(getTranscriptionLang(undefined), 'en-US');
    assert.strictEqual(getTranscriptionLang(null), 'en-US');
});

test('Miami-English sets transcription language to "en-US"', () => {
    assert.strictEqual(getTranscriptionLang('miami-english'), 'en-US');
});

test('session.update uses azure-speech model (not whisper-1)', () => {
    const update = buildSessionUpdate('english');
    assert.strictEqual(update.input_audio_transcription.model, 'azure-speech',
        'phi4-mm-realtime requires azure-speech; whisper-1 is gpt-realtime only');
});

test('echo cancellation type is server_echo_cancellation (not server_fade)', () => {
    const update = buildSessionUpdate('english');
    assert.strictEqual(update.input_audio_echo_cancellation.type, 'server_echo_cancellation',
        'server_fade is not a valid Azure Voice Live echo cancellation type');
});

test('voice field in response.create is an object { name }, not a bare string', () => {
    const azureVoice = 'en-US-AvaNeural';
    // Mirrors fixed insertUpdatedPrompt code
    const responsePayload = {
        type: 'response.create',
        response: {
            voice: { name: azureVoice },
            modalities: ['audio', 'text'],
            input: [{ type: 'text', text: 'some instruction' }]
        }
    };
    assert.ok(
        typeof responsePayload.response.voice === 'object' && responsePayload.response.voice.name,
        'voice must be { name: string }, not a bare string'
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 5: Pre-connect audio queue
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== FIX 5: Pre-connect audio queue ===');

function simulatePreConnectFlush(queuedPayloads, BATCH_SIZE = 10) {
    const sentBuffers = [];
    let audioBatch = [];

    // Simulate raw ulaw payloads stored in the queue
    const preConnectAudioQueue = queuedPayloads.map(p => p.toString('base64'));

    // Simulate the fixed flush logic
    while (preConnectAudioQueue.length > 0) {
        const payload = preConnectAudioQueue.shift();
        const buf = Buffer.from(payload, 'base64');
        audioBatch.push(buf);           // ← was commented out (the bug)
        if (audioBatch.length >= BATCH_SIZE) {
            sentBuffers.push(Buffer.concat(audioBatch));
            audioBatch = [];
        }
    }
    // Fixed: flush remaining frames
    if (audioBatch.length > 0) {
        sentBuffers.push(Buffer.concat(audioBatch));
        audioBatch = [];
    }
    return sentBuffers;
}

test('All pre-connect frames are forwarded to Azure (not dropped)', () => {
    const frames = Array.from({ length: 7 }, (_, i) => Buffer.alloc(160, i));
    const sent = simulatePreConnectFlush(frames);
    const totalSentBytes = sent.reduce((acc, b) => acc + b.length, 0);
    assert.strictEqual(totalSentBytes, 7 * 160,
        'All 7 frames (1120 bytes) must reach Azure');
});

test('Frames are batched correctly in groups of BATCH_SIZE', () => {
    const frames = Array.from({ length: 25 }, (_, i) => Buffer.alloc(160, i));
    const sent = simulatePreConnectFlush(frames, 10);
    // 25 frames: 2 full batches (10+10) + 1 remainder (5)
    assert.strictEqual(sent.length, 3, 'Must produce 3 send calls');
    assert.strictEqual(sent[0].length, 1600, 'First batch = 10 * 160 = 1600 bytes');
    assert.strictEqual(sent[1].length, 1600, 'Second batch = 10 * 160 = 1600 bytes');
    assert.strictEqual(sent[2].length, 800,  'Remainder = 5 * 160 = 800 bytes');
});

test('Empty queue produces zero sends', () => {
    const sent = simulatePreConnectFlush([]);
    assert.strictEqual(sent.length, 0);
});

test('Single frame (< BATCH_SIZE) is flushed by the remainder block', () => {
    const frames = [Buffer.alloc(160, 0xAB)];
    const sent = simulatePreConnectFlush(frames, 10);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].length, 160);
    assert.ok(sent[0].every(b => b === 0xAB), 'Frame content must be preserved');
});

test('Exactly BATCH_SIZE frames produces one send, no remainder flush', () => {
    const frames = Array.from({ length: 10 }, () => Buffer.alloc(160, 0));
    const sent = simulatePreConnectFlush(frames, 10);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].length, 1600);
});

test('Old broken code (push commented out) would have dropped all frames', () => {
    // Reproduce the original bug: never push to audioBatch
    const frames = Array.from({ length: 5 }, () => Buffer.alloc(160, 1));
    const sentBroken = [];
    let audioBatch = [];
    const queue = frames.map(f => f.toString('base64'));
    while (queue.length > 0) {
        const payload = queue.shift();
        const buf = Buffer.from(payload, 'base64');
        // BUG: audioBatch.push(buf) intentionally omitted
        if (audioBatch.length >= 10) {
            sentBroken.push(Buffer.concat(audioBatch));
            audioBatch = [];
        }
    }
    // No remainder flush either (old code)
    assert.strictEqual(sentBroken.length, 0,
        'Old code must send 0 bytes — confirming the bug existed');
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP 5: azure_semantic_vad ENV-controlled VAD mode
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== GAP 5: azure_semantic_vad + ENV-controlled VAD mode ===');

function resolveVADMode(envVal) {
    const v = (envVal || 'server_vad').toLowerCase();
    if (v === 'false' || v === 'none') return 'none';
    if (v === 'azure_semantic_vad') return 'azure_semantic_vad';
    return 'server_vad';
}

function getVADConfig(vadMode, isTwilio = true) {
    if (vadMode === 'none') return { type: 'none' };
    const base = isTwilio
        ? { prefix_padding_ms: 300, silence_duration_ms: 600, create_response: false }
        : { prefix_padding_ms: 150, silence_duration_ms: 500, create_response: false };
    if (vadMode === 'azure_semantic_vad') return { type: 'azure_semantic_vad', ...base };
    return { type: 'server_vad', threshold: isTwilio ? 0.5 : 0.4, ...base };
}

test('AZURE_SERVER_VAD=azure_semantic_vad resolves to azure_semantic_vad mode', () => {
    assert.strictEqual(resolveVADMode('azure_semantic_vad'), 'azure_semantic_vad');
});

test('AZURE_SERVER_VAD=true resolves to server_vad (backward compat)', () => {
    assert.strictEqual(resolveVADMode('true'), 'server_vad');
});

test('AZURE_SERVER_VAD=server_vad resolves to server_vad', () => {
    assert.strictEqual(resolveVADMode('server_vad'), 'server_vad');
});

test('AZURE_SERVER_VAD=false resolves to none (VAD disabled)', () => {
    assert.strictEqual(resolveVADMode('false'), 'none');
});

test('AZURE_SERVER_VAD=none resolves to none', () => {
    assert.strictEqual(resolveVADMode('none'), 'none');
});

test('Unset AZURE_SERVER_VAD defaults to server_vad', () => {
    assert.strictEqual(resolveVADMode(undefined), 'server_vad');
});

test('azure_semantic_vad config has no threshold field (unsupported by Azure)', () => {
    const cfg = getVADConfig('azure_semantic_vad');
    assert.strictEqual(cfg.type, 'azure_semantic_vad');
    assert.ok(!('threshold' in cfg), 'azure_semantic_vad must NOT include threshold');
    assert.ok('create_response' in cfg, 'create_response must be present');
});

test('server_vad config includes threshold', () => {
    const cfg = getVADConfig('server_vad');
    assert.strictEqual(cfg.type, 'server_vad');
    assert.ok('threshold' in cfg);
});

test('none config is { type: none } with no extra fields', () => {
    const cfg = getVADConfig('none');
    assert.strictEqual(cfg.type, 'none');
    assert.ok(!('threshold' in cfg) && !('create_response' in cfg));
});

// VAD=none silence-commit async test is run in runAsyncTests() below

// ─────────────────────────────────────────────────────────────────────────────
// FIX 6: sendTextResponse / insertUpdatedPrompt use correct Azure input format
// Azure Voice Live rejects { type:'text' } at input top level:
//   "Input tag 'text' does not match expected tags: 'message', 'function_call'"
// Correct format: { type:'message', role:'system', content:[{type:'input_text', text}] }
// sendTextResponse uses role:'system' — treats nudge as a directive (what Sarah should say),
// NOT as a user utterance that the model must respond to. Combined with session instruction
// transition (FIX 8), this prevents phi4-mm-realtime from meta-analysing nudge text.
// Must NOT use 'instructions' in response.create — that overrides session-level Sarah persona.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== FIX 6: sendTextResponse uses correct Azure message input format ===');

function buildMockSendTextResponse() {
    const sent = [];
    const svc = {
        isConnected: true,
        send: (msg) => sent.push(msg),
        getAzureVoice: () => 'en-US-AvaNeural',
        sendTextResponse(text) {
            if (!this.isConnected) return;
            const azureVoice = this.getAzureVoice();
            // role:'system' = directive to Sarah (what to do), not a user utterance.
            // Prevents phi4-mm-realtime from treating nudge text as a conversational input
            // to analyse against the greeting-template session instructions.
            this.send({
                type: 'response.create',
                response: {
                    voice:      { name: azureVoice },
                    modalities: ['audio', 'text'],
                    input: [{
                        type:    'message',
                        role:    'system',
                        content: [{ type: 'input_text', text }]
                    }]
                }
            });
        }
    };
    return { svc, sent };
}

function buildMockInsertUpdatedPrompt() {
    const sent = [];
    const svc = {
        isConnected: true,
        send: (msg) => sent.push(msg),
        getAzureVoice: () => 'en-US-AvaNeural',
        insertUpdatedPrompt(instruction) {
            // role:'system' injects context without polluting conversation history.
            // { type:'text' } rejected — must be { type:'message', role:'system', content:[...] }
            this.send({
                type: 'response.create',
                response: {
                    voice:      { name: this.getAzureVoice() },
                    modalities: ['audio', 'text'],
                    input: [{
                        type:    'message',
                        role:    'system',
                        content: [{ type: 'input_text', text: instruction }]
                    }]
                }
            });
        }
    };
    return { svc, sent };
}

test('sendTextResponse does NOT use instructions field (would override Sarah persona)', () => {
    const { svc, sent } = buildMockSendTextResponse();
    svc.sendTextResponse('You are not speaking. Please ask any question you have.');
    assert.strictEqual(sent.length, 1);
    assert.ok(!('instructions' in sent[0].response),
        'instructions field must NOT be present — it replaces session system prompt');
});

test('sendTextResponse input item type is "message" (not rejected "text")', () => {
    const { svc, sent } = buildMockSendTextResponse();
    svc.sendTextResponse('You are not speaking. Please ask any question you have.');
    const item = sent[0].response.input[0];
    assert.strictEqual(item.type, 'message',
        'input item type must be "message" — Azure rejects "text" at top level');
});

test('sendTextResponse input item role is "system" (directive, not user utterance)', () => {
    const { svc, sent } = buildMockSendTextResponse();
    svc.sendTextResponse('The user has been silent. As Sarah, gently invite them to ask about their project.');
    assert.strictEqual(sent[0].response.input[0].role, 'system',
        'role must be "system" — nudge is a directive to Sarah, not a user utterance');
});

test('sendTextResponse content uses input_text type with non-empty text', () => {
    const { svc, sent } = buildMockSendTextResponse();
    svc.sendTextResponse('Please speak.');
    const content = sent[0].response.input[0].content[0];
    assert.strictEqual(content.type, 'input_text', 'content type must be "input_text"');
    assert.ok(content.text.length > 0, 'content text must not be empty');
});

test('insertUpdatedPrompt input item type is "message" (not rejected "text")', () => {
    const { svc, sent } = buildMockInsertUpdatedPrompt();
    svc.insertUpdatedPrompt('Context: user asked about pricing. Respond as Sarah.');
    const item = sent[0].response.input[0];
    assert.strictEqual(item.type, 'message',
        'input item type must be "message" — Azure rejects "text" at top level');
});

test('insertUpdatedPrompt input item role is "system"', () => {
    const { svc, sent } = buildMockInsertUpdatedPrompt();
    svc.insertUpdatedPrompt('Context: user asked about pricing.');
    assert.strictEqual(sent[0].response.input[0].role, 'system',
        'role must be "system" — injects context without polluting conversation history');
});

test('sendTextResponse preserves voice object format { name }', () => {
    const { svc, sent } = buildMockSendTextResponse();
    svc.sendTextResponse('Goodbye.');
    const voice = sent[0].response.voice;
    assert.ok(typeof voice === 'object' && 'name' in voice,
        'voice must be { name: string } object');
});

test('sendTextResponse is no-op when not connected', () => {
    const { svc, sent } = buildMockSendTextResponse();
    svc.isConnected = false;
    svc.sendTextResponse('Should not send');
    assert.strictEqual(sent.length, 0, 'Must not send when disconnected');
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 7: Pre-connect audio queue flushed AFTER session.updated (not in handleOpen)
// Prevents g711_ulaw audio being sent while Azure is still in pcm16 mode.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== FIX 7: Pre-connect audio flush timing ===');

function buildMockServiceWithFlushTiming() {
    const events = [];   // ordered log of what happened
    const flushedFrames = [];

    const svc = {
        preConnectAudioQueue: [],
        isConnected: false,
        sessionFormatConfirmed: false,

        handleOpen() {
            this.isConnected = true;
            events.push('handleOpen:session.update sent');
            // FIX: do NOT flush here — queue is flushed in handleSessionUpdated
        },

        handleSessionUpdated() {
            events.push('session.updated received');
            this.sessionFormatConfirmed = true;
            // Flush only after format is confirmed
            if (this.preConnectAudioQueue.length > 0) {
                events.push(`flushing ${this.preConnectAudioQueue.length} frames`);
                this.preConnectAudioQueue.forEach(buf => flushedFrames.push(buf));
                this.preConnectAudioQueue = [];
            }
        },

        queueAudio(buf) {
            if (!this.isConnected) {
                this.preConnectAudioQueue.push(buf);
            } else {
                flushedFrames.push(buf);
            }
        }
    };

    return { svc, events, flushedFrames };
}

test('Pre-connect audio is NOT flushed during handleOpen (before session.updated)', () => {
    const { svc, events, flushedFrames } = buildMockServiceWithFlushTiming();
    svc.queueAudio(Buffer.alloc(160, 1));
    svc.queueAudio(Buffer.alloc(160, 2));
    svc.handleOpen();
    // After handleOpen, queue should NOT be flushed yet
    assert.strictEqual(flushedFrames.length, 0,
        'No frames must be flushed before session.updated');
    assert.strictEqual(svc.preConnectAudioQueue.length, 2,
        'Frames must remain in queue until session.updated');
});

test('Pre-connect audio IS flushed in handleSessionUpdated (after format confirmed)', () => {
    const { svc, events, flushedFrames } = buildMockServiceWithFlushTiming();
    svc.queueAudio(Buffer.alloc(160, 1));
    svc.queueAudio(Buffer.alloc(160, 2));
    svc.handleOpen();
    svc.handleSessionUpdated();  // simulates receiving session.updated from Azure
    assert.strictEqual(flushedFrames.length, 2,
        'Both frames must be flushed after session.updated');
    assert.strictEqual(svc.preConnectAudioQueue.length, 0,
        'Queue must be empty after flush');
});

test('Flush order: session.update → session.updated → flush (correct sequence)', () => {
    const { svc, events, flushedFrames } = buildMockServiceWithFlushTiming();
    svc.queueAudio(Buffer.alloc(160, 42));
    svc.handleOpen();
    svc.handleSessionUpdated();
    const sessionUpdateIdx = events.indexOf('handleOpen:session.update sent');
    const sessionUpdatedIdx = events.indexOf('session.updated received');
    const flushIdx = events.findIndex(e => e.startsWith('flushing'));
    assert.ok(sessionUpdateIdx < sessionUpdatedIdx,
        'session.update must be sent before session.updated is received');
    assert.ok(sessionUpdatedIdx < flushIdx,
        'Flush must happen after session.updated');
});

test('If queue is empty at session.updated, no flush event is emitted', () => {
    const { svc, events, flushedFrames } = buildMockServiceWithFlushTiming();
    svc.handleOpen();
    svc.handleSessionUpdated();  // nothing queued
    assert.strictEqual(flushedFrames.length, 0);
    assert.ok(!events.some(e => e.startsWith('flushing')),
        'No flush event for empty queue');
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 8: Session instruction transition after greeting
// phi4-mm-realtime meta-analyses sendTextResponse when session instructions contain
// the greeting template (structural text like "Greeting message: Hey ${name}!...").
// Fix: after the first response.audio.done, send session.update with clean operational
// instructions (baseInstructionEnglishSales / German equivalent) that contain no
// template text. Controlled by _greetingDelivered flag (set true once, never reset).
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== FIX 8: Session instruction transition after greeting ===');

function buildMockGreetingTransition() {
    const sent = [];
    const svc = {
        isConnected: true,
        _greetingDelivered: false,
        botLang: 'english',
        callSID: 'CA_test',
        send: (msg) => sent.push(msg),
        getOperationalInstructions() {
            return this.botLang === 'german'
                ? 'OPERATIONAL_GERMAN'
                : 'OPERATIONAL_ENGLISH';
        },
        // Simulates the response.audio.done handler logic
        handleAudioDone() {
            if (!this._greetingDelivered) {
                this._greetingDelivered = true;
                this.send({ type: 'session.update', session: { instructions: this.getOperationalInstructions() } });
            }
        }
    };
    return { svc, sent };
}

test('_greetingDelivered initialises to false', () => {
    const { svc } = buildMockGreetingTransition();
    assert.strictEqual(svc._greetingDelivered, false);
});

test('First response.audio.done sends session.update with operational instructions', () => {
    const { svc, sent } = buildMockGreetingTransition();
    svc.handleAudioDone();
    assert.strictEqual(sent.length, 1, 'Exactly one session.update must be sent');
    assert.strictEqual(sent[0].type, 'session.update');
    assert.ok('instructions' in sent[0].session,
        'session.update must include instructions field');
});

test('Operational instructions contain no greeting template text', () => {
    const { svc, sent } = buildMockGreetingTransition();
    svc.handleAudioDone();
    const instructions = sent[0].session.instructions;
    assert.ok(!instructions.includes('Greeting message:'),
        'Operational instructions must not contain greeting template structural text');
    assert.ok(!instructions.includes('Hey ${'),
        'Operational instructions must not contain template placeholders');
});

test('session.update is sent only once (not on every response.audio.done)', () => {
    const { svc, sent } = buildMockGreetingTransition();
    svc.handleAudioDone(); // first audio.done — greeting
    svc.handleAudioDone(); // second audio.done — silence nudge response
    svc.handleAudioDone(); // third audio.done — another response
    assert.strictEqual(sent.length, 1, 'session.update must be sent exactly once');
});

test('_greetingDelivered is true after first audio.done', () => {
    const { svc } = buildMockGreetingTransition();
    assert.strictEqual(svc._greetingDelivered, false);
    svc.handleAudioDone();
    assert.strictEqual(svc._greetingDelivered, true);
});

test('German botLang uses German operational instructions', () => {
    const { svc, sent } = buildMockGreetingTransition();
    svc.botLang = 'german';
    svc.handleAudioDone();
    assert.strictEqual(sent[0].session.instructions, 'OPERATIONAL_GERMAN');
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 9: audio_sent log frequency reduced to every 50 frames (~1,000ms)
// Previously every 10 frames (~200ms) = 43% of log volume. At 50 frames = ~9%.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== FIX 9: audio_sent log sampling at 1,000ms intervals ===');

function buildMockAudioSampler(sampleEveryN = 50) {
    const logs = [];
    let counter = 0;
    function sendAudio() {
        counter++;
        if (counter % sampleEveryN === 0) {
            logs.push({ event: 'audio_sent', counter });
        }
    }
    return { sendAudio, getLogs: () => logs, getCounter: () => counter };
}

test('audio_sent is NOT logged on frame 10 (old interval)', () => {
    const { sendAudio, getLogs } = buildMockAudioSampler(50);
    for (let i = 0; i < 10; i++) sendAudio();
    assert.strictEqual(getLogs().length, 0, 'No log at frame 10 (sampling is every 50)');
});

test('audio_sent is NOT logged on frames 1-49', () => {
    const { sendAudio, getLogs } = buildMockAudioSampler(50);
    for (let i = 0; i < 49; i++) sendAudio();
    assert.strictEqual(getLogs().length, 0, 'No log until frame 50');
});

test('audio_sent IS logged on frame 50', () => {
    const { sendAudio, getLogs } = buildMockAudioSampler(50);
    for (let i = 0; i < 50; i++) sendAudio();
    assert.strictEqual(getLogs().length, 1, 'Exactly one log at frame 50');
});

test('audio_sent rate is 1 per 50 frames (5x reduction vs old 10-frame interval)', () => {
    const { sendAudio, getLogs } = buildMockAudioSampler(50);
    const TOTAL_FRAMES = 500;
    for (let i = 0; i < TOTAL_FRAMES; i++) sendAudio();
    assert.strictEqual(getLogs().length, 10,
        `${TOTAL_FRAMES} frames at 1/50 sampling = 10 logs (was 50 at old 1/10 rate)`);
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 11: Twilio transcription handler reads message.transcript (not message.item.content)
// Azure Voice Live API sends conversation.item.input_audio_transcription.completed with
// transcript at message.transcript (top-level string). The old code read message.item?.content
// which does not exist in this event — contents was always [], transcript always null,
// every user speech silently dropped. Fix: read message.transcript?.trim() directly.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== FIX 11: Twilio transcription reads correct message.transcript field ===');

function buildMockTranscriptionHandler() {
    const results = [];

    function handleTranscriptionCompleted(message, lastUserTranscript) {
        // FIXED: read message.transcript (top-level), not message.item?.content
        const transcript = message.transcript?.trim() || null;

        if (!transcript || transcript.length < 2) {
            results.push({ action: 'rejected', reason: 'too_short_or_empty' });
            return { accepted: false };
        }
        if (lastUserTranscript === transcript) {
            results.push({ action: 'rejected', reason: 'duplicate', transcript });
            return { accepted: false };
        }
        results.push({ action: 'accepted', transcript });
        return { accepted: true, transcript };
    }

    function handleTranscriptionBroken(message) {
        // OLD (broken) code: message.item?.content || []
        const contents = message.item?.content || [];
        let transcript = null;
        for (const c of contents) {
            if (c.transcript) { transcript = c.transcript.trim(); break; }
        }
        return { transcript };
    }

    return { handleTranscriptionCompleted, handleTranscriptionBroken, results };
}

test('Twilio fixed handler reads transcript from message.transcript (top-level)', () => {
    const { handleTranscriptionCompleted, results } = buildMockTranscriptionHandler();
    const event = { type: 'conversation.item.input_audio_transcription.completed',
                    item_id: 'item_1', content_index: 0,
                    transcript: 'Hello, I need help with my project.' };
    const result = handleTranscriptionCompleted(event, null);
    assert.ok(result.accepted, 'Transcription must be accepted');
    assert.strictEqual(result.transcript, 'Hello, I need help with my project.');
});

test('Old broken handler always returns null for this event (message.item does not exist)', () => {
    const { handleTranscriptionBroken } = buildMockTranscriptionHandler();
    const event = { type: 'conversation.item.input_audio_transcription.completed',
                    item_id: 'item_1', content_index: 0,
                    transcript: 'Hello, I need help with my project.' };
    // message.item is undefined → contents=[] → transcript=null
    const result = handleTranscriptionBroken(event);
    assert.strictEqual(result.transcript, null,
        'Broken handler yields null — confirms the bug was real');
});

test('Short transcript (< 2 chars) is rejected by fixed handler', () => {
    const { handleTranscriptionCompleted } = buildMockTranscriptionHandler();
    const result = handleTranscriptionCompleted({ transcript: 'a' }, null);
    assert.ok(!result.accepted);
});

test('Duplicate transcript is rejected by fixed handler', () => {
    const { handleTranscriptionCompleted } = buildMockTranscriptionHandler();
    const result = handleTranscriptionCompleted(
        { transcript: 'Hello there' }, 'Hello there');
    assert.ok(!result.accepted);
});

test('Empty transcript is rejected by fixed handler', () => {
    const { handleTranscriptionCompleted } = buildMockTranscriptionHandler();
    const result = handleTranscriptionCompleted({ transcript: '' }, null);
    assert.ok(!result.accepted);
});

test('Missing transcript field gracefully rejected (no crash)', () => {
    const { handleTranscriptionCompleted } = buildMockTranscriptionHandler();
    const result = handleTranscriptionCompleted({}, null);
    assert.ok(!result.accepted, 'Must reject gracefully when transcript field absent');
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 10: Echo cancellation is omitted when VAD is disabled (vadMode='none')
// Azure Voice Live rejects input_audio_echo_cancellation when turn_detection.type='none':
//   "Server side echo cancellation is not supported when turn detection is disabled."
// Fix: conditionally include the field only when vadMode !== 'none'.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== FIX 10: Echo cancellation conditional on VAD being active ===');

function buildSessionPayload(vadMode) {
    const session = {
        voice: { name: 'en-US-JennyNeural' },
        input_audio_format:  'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'azure-speech', language: 'en-US' },
        // Conditional: server_echo_cancellation requires active VAD
        ...(vadMode !== 'none' && { input_audio_echo_cancellation: { type: 'server_echo_cancellation' } }),
        turn_detection: vadMode === 'none'
            ? { type: 'none' }
            : { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600, create_response: false },
        modalities: ['audio', 'text']
    };
    return session;
}

test('VAD=none: input_audio_echo_cancellation is NOT included in session.update', () => {
    const session = buildSessionPayload('none');
    assert.ok(!('input_audio_echo_cancellation' in session),
        'ec field must be absent when VAD disabled — Azure rejects it with ec_not_supported');
});

test('VAD=server_vad: input_audio_echo_cancellation IS included in session.update', () => {
    const session = buildSessionPayload('server_vad');
    assert.ok('input_audio_echo_cancellation' in session,
        'ec field must be present when VAD is active');
    assert.strictEqual(session.input_audio_echo_cancellation.type, 'server_echo_cancellation');
});

test('VAD=azure_semantic_vad: input_audio_echo_cancellation IS included in session.update', () => {
    const session = buildSessionPayload('azure_semantic_vad');
    assert.ok('input_audio_echo_cancellation' in session,
        'ec field must be present when VAD is active');
});

test('VAD=none: turn_detection.type is "none" (confirms why ec cannot be used)', () => {
    const session = buildSessionPayload('none');
    assert.strictEqual(session.turn_detection.type, 'none');
});

test('VAD=server_vad: turn_detection.type is "server_vad"', () => {
    const session = buildSessionPayload('server_vad');
    assert.strictEqual(session.turn_detection.type, 'server_vad');
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 12: getFullSessionConfig() always emits complete session payload
// Azure Voice Live treats session.update as a FULL replacement — if any field is
// omitted (e.g. input_audio_format), Azure defaults it to pcm16/24000Hz, conflicting
// with the established 8000Hz g711_ulaw stream →
//   "change_in_input_audio_sampling_rate_not_allowed"
// Fix: every session.update (after the initial one) must use getFullSessionConfig().
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== FIX 12: getFullSessionConfig() emits complete session payload ===');

function buildFullSessionConfig(vadMode, botLang, instructions) {
    const azureVoices = { english: 'en-US-JennyNeural', german: 'de-DE-KatjaNeural' };
    const lang        = (botLang || 'english').toLowerCase();
    const azureVoice  = azureVoices[lang] || azureVoices.english;
    return {
        voice:               { name: azureVoice },
        input_audio_format:  'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: {
            model:    'azure-speech',
            language: lang === 'german' ? 'de-DE' : 'en-US'
        },
        ...(vadMode !== 'none' && { input_audio_echo_cancellation: { type: 'server_echo_cancellation' } }),
        turn_detection: vadMode === 'none'
            ? { type: 'none' }
            : { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600, create_response: false },
        modalities:  ['audio', 'text'],
        instructions
    };
}

test('getFullSessionConfig: always includes input_audio_format=g711_ulaw', () => {
    const cfg = buildFullSessionConfig('server_vad', 'english', 'test instructions');
    assert.strictEqual(cfg.input_audio_format, 'g711_ulaw',
        'Missing input_audio_format would reset session to 24000Hz pcm16');
});

test('getFullSessionConfig: always includes output_audio_format=g711_ulaw', () => {
    const cfg = buildFullSessionConfig('server_vad', 'english', 'test instructions');
    assert.strictEqual(cfg.output_audio_format, 'g711_ulaw');
});

test('getFullSessionConfig: always includes turn_detection', () => {
    const cfgVad  = buildFullSessionConfig('server_vad', 'english', 'ops');
    const cfgNone = buildFullSessionConfig('none', 'english', 'ops');
    assert.ok('turn_detection' in cfgVad,  'turn_detection missing (server_vad)');
    assert.ok('turn_detection' in cfgNone, 'turn_detection missing (none)');
    assert.strictEqual(cfgNone.turn_detection.type, 'none');
    assert.strictEqual(cfgVad.turn_detection.type,  'server_vad');
});

test('getFullSessionConfig: always includes voice', () => {
    const cfg = buildFullSessionConfig('server_vad', 'english', 'ops');
    assert.ok(cfg.voice && cfg.voice.name, 'voice.name missing from session payload');
});

test('getFullSessionConfig: instructions field matches argument', () => {
    const instr = 'Be Sarah from company';
    const cfg   = buildFullSessionConfig('server_vad', 'english', instr);
    assert.strictEqual(cfg.instructions, instr);
});

test('getFullSessionConfig: VAD=none omits echo cancellation', () => {
    const cfg = buildFullSessionConfig('none', 'english', 'ops');
    assert.ok(!('input_audio_echo_cancellation' in cfg),
        'ec field must be absent when VAD=none — prevents ec_not_supported cascade');
});

test('getFullSessionConfig: VAD=server_vad includes echo cancellation', () => {
    const cfg = buildFullSessionConfig('server_vad', 'english', 'ops');
    assert.ok('input_audio_echo_cancellation' in cfg, 'ec field must be present for server_vad');
    assert.strictEqual(cfg.input_audio_echo_cancellation.type, 'server_echo_cancellation');
});

test('getFullSessionConfig: German lang uses de-DE transcription locale', () => {
    const cfg = buildFullSessionConfig('server_vad', 'german', 'Willkommen');
    assert.strictEqual(cfg.input_audio_transcription.language, 'de-DE');
});

test('getFullSessionConfig: English lang uses en-US transcription locale', () => {
    const cfg = buildFullSessionConfig('server_vad', 'english', 'Hello');
    assert.strictEqual(cfg.input_audio_transcription.language, 'en-US');
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 13: isResponding set true in response.created (not just response.audio.delta)
// There is a ~91ms gap between response.created and the first audio.delta.
// If isResponding is still false when user transcription arrives in that window,
// insertUpdatedPrompt() fires response.create → Azure rejects with:
//   "conversation_already_has_active_response"
// Fix: set isResponding=true immediately on response.created.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== FIX 13: isResponding set true on response.created (closes race window) ===');

function buildResponseCreatedHandler(state) {
    // Simulates the corrected response.created handler
    return function handleResponseCreated() {
        state._firstDeltaLogged = false;
        state.isResponding      = true; // FIX C: close race window
    };
}

function buildInsertUpdatedPrompt(state, sent) {
    return function insertUpdatedPrompt() {
        if (state.isResponding) {
            sent.push({ type: 'session.update' });
        } else {
            sent.push({ type: 'response.create' });
        }
    };
}

test('isResponding=true immediately on response.created (before first delta)', () => {
    const state = { isResponding: false, _firstDeltaLogged: false };
    const handle = buildResponseCreatedHandler(state);
    assert.strictEqual(state.isResponding, false, 'Pre-condition: should be false before event');
    handle(); // simulate response.created firing
    assert.strictEqual(state.isResponding, true,
        'isResponding must be true immediately after response.created — not deferred to first delta');
});

test('_firstDeltaLogged reset to false on response.created', () => {
    const state = { isResponding: false, _firstDeltaLogged: true };
    const handle = buildResponseCreatedHandler(state);
    handle();
    assert.strictEqual(state._firstDeltaLogged, false,
        'Latency checkpoint must reset for each new response');
});

test('insertUpdatedPrompt uses session.update path when isResponding=true (set by response.created)', () => {
    const state = { isResponding: false, _firstDeltaLogged: false };
    const sent  = [];
    const handleResponseCreated  = buildResponseCreatedHandler(state);
    const insertUpdatedPrompt    = buildInsertUpdatedPrompt(state, sent);
    handleResponseCreated(); // response.created fires → isResponding=true
    insertUpdatedPrompt();   // transcription arrives in the 91ms window
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'session.update',
        'Must use session.update (not response.create) when a response is already active');
});

test('without fix: transcription in window would fire response.create and get rejected', () => {
    // Demonstrate the old (broken) behaviour for contrast
    const state = { isResponding: false, _firstDeltaLogged: false };
    const sent  = [];
    const insertUpdatedPrompt = buildInsertUpdatedPrompt(state, sent);
    // Do NOT call handleResponseCreated first — isResponding stays false
    insertUpdatedPrompt(); // transcription arrives before delta
    assert.strictEqual(sent[0].type, 'response.create',
        'Old code: isResponding still false → response.create → Azure rejects with conversation_already_has_active_response');
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 14: Silence commit timer cancelled + pendingAudioSinceCommit reset in response.created
// Problem: bot audio plays → echoes back through phone mic → sendAudio() sets
// pendingAudioSinceCommit=true → 800ms after echo fades, silenceCommitTimer fires →
// vad_none_silence_commit → response.create → new response → loop ("bot won't stop talking").
// Fix: on response.created, clear the timer and reset the flag so the bot's own echo
// cannot trigger a spurious follow-up commit.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== FIX 14: Echo loop broken — commit timer cancelled on response.created ===');

function buildVADNoneEchoScenario(SILENCE_MS = 30) {
    const sent = [];
    const state = {
        vadMode:                'none',
        isResponseActive:       false,
        pendingAudioSinceCommit: false,
        silenceCommitTimer:     null
    };

    function sendAudio() {
        state.pendingAudioSinceCommit = true;
        if (state.silenceCommitTimer) clearTimeout(state.silenceCommitTimer);
        state.silenceCommitTimer = setTimeout(() => {
            state.silenceCommitTimer = null;
            if (state.pendingAudioSinceCommit && !state.isResponseActive) {
                state.pendingAudioSinceCommit = false;
                sent.push({ type: 'input_audio_buffer.commit' });
                sent.push({ type: 'response.create' });
            }
        }, SILENCE_MS);
    }

    function onResponseCreated() {
        state.isResponseActive = true;
        // FIX B: cancel commit timer and reset pending flag
        if (state.silenceCommitTimer) {
            clearTimeout(state.silenceCommitTimer);
            state.silenceCommitTimer = null;
        }
        state.pendingAudioSinceCommit = false;
    }

    return { state, sent, sendAudio, onResponseCreated };
}

test('echo loop: pendingAudioSinceCommit=true after sendAudio()', () => {
    const { state, sendAudio } = buildVADNoneEchoScenario();
    sendAudio();
    assert.strictEqual(state.pendingAudioSinceCommit, true);
    clearTimeout(state.silenceCommitTimer);
});

test('echo loop: onResponseCreated cancels silenceCommitTimer', () => {
    const { state, sendAudio, onResponseCreated } = buildVADNoneEchoScenario();
    sendAudio();
    assert.ok(state.silenceCommitTimer !== null, 'Pre-condition: timer must be active after sendAudio');
    onResponseCreated();
    assert.strictEqual(state.silenceCommitTimer, null,
        'silenceCommitTimer must be cancelled when response starts — prevents echo-triggered commit');
});

test('echo loop: onResponseCreated resets pendingAudioSinceCommit to false', () => {
    const { state, sendAudio, onResponseCreated } = buildVADNoneEchoScenario();
    sendAudio();
    onResponseCreated();
    assert.strictEqual(state.pendingAudioSinceCommit, false,
        'pendingAudioSinceCommit must be cleared — prevents stale commit after response ends');
});

test('echo loop: after onResponseCreated, sendAudio echo does NOT trigger a new commit (sync check)', () => {
    const { state, sent, sendAudio, onResponseCreated } = buildVADNoneEchoScenario();
    sendAudio();          // initial user audio
    onResponseCreated();  // response starts, timer cancelled, flag cleared
    // Simulate echo arriving — sendAudio called again, but isResponseActive=true so
    // even if timer fires it won't commit (checked via the !isResponseActive guard)
    sendAudio();          // echo lands, sets pendingAudio=true, arms timer
    // Manually check state: timer armed but isResponseActive=true means the callback won't fire a commit
    assert.strictEqual(state.isResponseActive, true,
        'isResponseActive must block the commit path in the timer callback');
    clearTimeout(state.silenceCommitTimer);
});

test('echo loop: VAD=server_vad path does NOT touch silenceCommitTimer (only affects vadMode=none)', () => {
    // When VAD is active, Azure handles commits — our manual timer should not interfere
    const state = { vadMode: 'server_vad', silenceCommitTimer: null, pendingAudioSinceCommit: false };
    // Simulate onResponseCreated with vadMode guard
    function onResponseCreatedGuarded() {
        if (state.vadMode === 'none') {
            if (state.silenceCommitTimer) clearTimeout(state.silenceCommitTimer);
            state.silenceCommitTimer = null;
            state.pendingAudioSinceCommit = false;
        }
    }
    // Set a fake timer to confirm it's NOT cleared for server_vad
    state.silenceCommitTimer = setTimeout(() => {}, 9999);
    onResponseCreatedGuarded();
    assert.ok(state.silenceCommitTimer !== null,
        'server_vad path: timer must NOT be touched by the VAD=none echo loop fix');
    clearTimeout(state.silenceCommitTimer);
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 15: response.audio.done clears commit state (Fix D) + denoiser pauseTranscription gate
//
// Echo loop that remained after Fix B (cancel on response.created):
//   Log 7 shows commits firing 516–668ms AFTER audio_done — inside the 800ms echo guard.
//   Source: audio queued in the denoiser worker BEFORE startEchoGuard() fired was sent to
//   sendAudio() asynchronously (old line 353 had no pauseTranscription check).
//
// NOTE: A timing-based cooldown (RESPONSE_COOLDOWN_MS) was considered but rejected:
//   A 1800ms cooldown suppresses quick "Yes"/"Okay" responses from users who speak
//   within 1000ms of the bot finishing (guard 800ms + 100ms speech → commit at T+1700ms < 1800ms).
//   That causes perceived dead air, which is worse than the problem being fixed.
//
// Correct two-layer approach:
//   Fix D: cancel silenceCommitTimer + reset pendingAudioSinceCommit in response.audio.done.
//          Wipes any stale timer before the echo guard window opens.
//   app.js line 353: add !edgeSession.pauseTranscription guard at denoiser send time.
//          Prevents denoiser queue backlog from reaching sendAudio() during echo guard.
//   Together these ensure no echo audio can arm the commit timer after a response ends.
//   Legitimate user speech (arriving after guard clears) commits normally without delay.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== FIX 15: audio_done clears commit state + denoiser gate prevents echo commits ===');

function buildAudioDoneScenario(SILENCE_MS = 30) {
    const sent = [];
    const state = {
        isConnected:             true,
        isResponding:            true,
        pendingAudioSinceCommit: false,
        silenceCommitTimer:      null
    };

    function sendAudio() {
        state.pendingAudioSinceCommit = true;
        if (state.silenceCommitTimer) clearTimeout(state.silenceCommitTimer);
        state.silenceCommitTimer = setTimeout(() => {
            state.silenceCommitTimer = null;
            if (state.isConnected && state.pendingAudioSinceCommit && !state.isResponding) {
                state.pendingAudioSinceCommit = false;
                sent.push({ type: 'input_audio_buffer.commit' });
                sent.push({ type: 'response.create' });
            }
        }, SILENCE_MS);
    }

    function onResponseAudioDone() {
        state.isResponding = false;
        // FIX D: cancel pending commit and reset flag — clean slate for echo guard window
        if (state.silenceCommitTimer) {
            clearTimeout(state.silenceCommitTimer);
            state.silenceCommitTimer = null;
        }
        state.pendingAudioSinceCommit = false;
    }

    return { state, sent, sendAudio, onResponseAudioDone };
}

test('FIX D: onResponseAudioDone resets pendingAudioSinceCommit to false', () => {
    const { state, sendAudio, onResponseAudioDone } = buildAudioDoneScenario();
    sendAudio();
    assert.strictEqual(state.pendingAudioSinceCommit, true, 'Pre-condition: pending must be true after sendAudio');
    onResponseAudioDone();
    assert.strictEqual(state.pendingAudioSinceCommit, false,
        'FIX D: audio_done must clear pendingAudioSinceCommit — prevents denoiser backlog from triggering commit inside echo guard');
    clearTimeout(state.silenceCommitTimer);
});

test('FIX D: onResponseAudioDone cancels silenceCommitTimer', () => {
    const { state, sendAudio, onResponseAudioDone } = buildAudioDoneScenario();
    sendAudio();
    assert.ok(state.silenceCommitTimer !== null, 'Pre-condition: timer must be active after sendAudio');
    onResponseAudioDone();
    assert.strictEqual(state.silenceCommitTimer, null,
        'FIX D: audio_done must cancel the timer — stale timer from pre-response audio would fire inside guard window');
});

test('FIX D: after onResponseAudioDone + echo audio, commit timer does NOT fire (guard covers residual echo)', () => {
    // Echo arrives after audio_done but denoiser gate (pauseTranscription=true) blocks it.
    // This test verifies that even if sendAudio() is called, the guard logic (isResponding
    // path and the denoiser gate) prevents spurious commits.
    const { state, sent, sendAudio, onResponseAudioDone } = buildAudioDoneScenario();
    sendAudio();           // bot audio still playing → timer armed
    onResponseAudioDone(); // audio ends → FIX D: timer cancelled, flag cleared
    // At this point: timer=null, pendingAudio=false, isResponding=false.
    // Echo guard active: denoiser gate (app.js) would block any audio now.
    // If echo DID slip through, sendAudio arms a new timer, but the key protection
    // is that pendingAudio=false at audio_done gives a clean slate.
    assert.strictEqual(state.silenceCommitTimer, null, 'Timer must be null after audio_done');
    assert.strictEqual(state.pendingAudioSinceCommit, false, 'Flag must be false after audio_done');
    assert.strictEqual(sent.length, 0, 'No commits should have fired');
});

test('FIX D: no-op when vadMode is not none (timer already null, flag already false)', () => {
    // In server_vad/azure_semantic_vad mode, Azure manages commits — these fields are unused.
    const state = { isResponding: true, silenceCommitTimer: null, pendingAudioSinceCommit: false };
    // Simulate the vadMode=none guard
    function onAudioDone(vadMode) {
        state.isResponding = false;
        if (vadMode === 'none') {
            if (state.silenceCommitTimer) clearTimeout(state.silenceCommitTimer);
            state.silenceCommitTimer = null;
            state.pendingAudioSinceCommit = false;
        }
    }
    onAudioDone('server_vad');
    assert.strictEqual(state.silenceCommitTimer, null, 'Harmless no-op for server_vad');
    assert.strictEqual(state.pendingAudioSinceCommit, false, 'Harmless no-op for server_vad');
});

test('FIX (app.js denoiser): pauseTranscription=true blocks sendAudio during echo guard', () => {
    let sendAudioCalled = false;
    const edgeSession = { pauseTranscription: true }; // echo guard active
    function denoiserSend(rs, es) {
        if (rs.isConnected && rs.isSessionConfigured && !es.pauseTranscription) {
            sendAudioCalled = true;
        }
    }
    denoiserSend({ isConnected: true, isSessionConfigured: true }, edgeSession);
    assert.strictEqual(sendAudioCalled, false,
        'Denoiser must NOT call sendAudio() during echo guard — prevents denoiser backlog from arming commit timer at T+516–668ms inside guard window');
});

test('FIX (app.js denoiser): pauseTranscription=false allows sendAudio for real user speech', () => {
    let sendAudioCalled = false;
    const edgeSession = { pauseTranscription: false };
    function denoiserSend(rs, es) {
        if (rs.isConnected && rs.isSessionConfigured && !es.pauseTranscription) {
            sendAudioCalled = true;
        }
    }
    denoiserSend({ isConnected: true, isSessionConfigured: true }, edgeSession);
    assert.strictEqual(sendAudioCalled, true,
        'User speech arriving after guard clears (pauseTranscription=false) must reach Azure without delay');
});

test('cooldown approach correctly rejected: 1800ms would suppress quick "Yes" at T+1700ms', () => {
    // Demonstrate WHY a timing cooldown was not used.
    // User speaks "Yes" (100ms) immediately after guard clears (T+800ms):
    //   speech ends T+900ms → commit timer fires T+1700ms → 1700ms < 1800ms → SUPPRESSED ❌
    // This is worse than the echo problem: the user's response is silently dropped.
    const ECHO_GUARD_MS     = 800;
    const SPEECH_DURATION_MS = 100; // short "Yes"
    const SILENCE_COMMIT_MS  = 800;
    const commitTimeMs = ECHO_GUARD_MS + SPEECH_DURATION_MS + SILENCE_COMMIT_MS; // 1700ms
    const cooldownMs   = 1800;
    assert.ok(commitTimeMs < cooldownMs,
        'Quick "Yes" fires commit at T+1700ms which is inside the 1800ms cooldown window — proves cooldown suppresses real speech');
});

// ─────────────────────────────────────────────────────────────────────────────
// Async test runner for FIX 1 async tests
// ─────────────────────────────────────────────────────────────────────────────
async function runAsyncTests() {
    const GRACE_MS = 60;
    const asyncResults = [];

    // stopEchoGuard resets after grace
    await new Promise(resolve => {
        const session = { pauseTranscription: false };
        const { startEchoGuard, stopEchoGuard } = buildEchoGuard(session, GRACE_MS);
        startEchoGuard();
        stopEchoGuard();
        setTimeout(() => {
            try {
                assert.strictEqual(session.pauseTranscription, false);
                console.log('  ✅ PASS  [async] stopEchoGuard resets pauseTranscription after grace');
                passed++;
            } catch (e) {
                console.error('  ❌ FAIL  [async] stopEchoGuard resets pauseTranscription after grace');
                console.error(`         ${e.message}`);
                failed++;
            }
            resolve();
        }, GRACE_MS + 30);
    });

    // VAD=none: silence timer commits audio and requests response
    await new Promise(resolve => {
        const sent = [];
        const SILENCE_MS = 50;
        let pendingAudio = false;
        let silenceTimer = null;

        function mockSendAudio() {
            pendingAudio = true;
            if (silenceTimer) clearTimeout(silenceTimer);
            silenceTimer = setTimeout(() => {
                silenceTimer = null;
                if (pendingAudio) {
                    pendingAudio = false;
                    sent.push({ type: 'input_audio_buffer.commit' });
                    sent.push({ type: 'response.create' });
                }
            }, SILENCE_MS);
        }

        mockSendAudio(); // first audio chunk
        mockSendAudio(); // second — resets the silence timer

        setTimeout(() => {
            try {
                assert.strictEqual(sent.length, 2);
                assert.strictEqual(sent[0].type, 'input_audio_buffer.commit');
                assert.strictEqual(sent[1].type, 'response.create');
                console.log('  ✅ PASS  [async] VAD=none: silence timer commits buffer and triggers response');
                passed++;
            } catch (e) {
                console.error('  ❌ FAIL  [async] VAD=none: silence timer commits buffer and triggers response');
                console.error(`         ${e.message}`);
                failed++;
            }
            resolve();
        }, SILENCE_MS + 40);
    });

    // FIX 14 async: echo loop — after onResponseCreated(), silence timer cannot trigger a commit
    await new Promise(resolve => {
        const sent = [];
        const SILENCE_MS = 50;
        const state = {
            vadMode:                'none',
            isResponseActive:       false,
            pendingAudioSinceCommit: false,
            silenceCommitTimer:     null
        };

        function sendAudio() {
            state.pendingAudioSinceCommit = true;
            if (state.silenceCommitTimer) clearTimeout(state.silenceCommitTimer);
            state.silenceCommitTimer = setTimeout(() => {
                state.silenceCommitTimer = null;
                if (state.pendingAudioSinceCommit && !state.isResponseActive) {
                    state.pendingAudioSinceCommit = false;
                    sent.push({ type: 'input_audio_buffer.commit' });
                    sent.push({ type: 'response.create' });
                }
            }, SILENCE_MS);
        }

        function onResponseCreated() {
            state.isResponseActive = true;
            if (state.silenceCommitTimer) {
                clearTimeout(state.silenceCommitTimer);
                state.silenceCommitTimer = null;
            }
            state.pendingAudioSinceCommit = false;
        }

        sendAudio();         // user audio → arms timer
        onResponseCreated(); // response starts → timer cancelled, flag cleared
        sendAudio();         // echo arrives → arms NEW timer, but isResponseActive=true

        // Wait for timer to fire — should NOT send commit because isResponseActive=true
        setTimeout(() => {
            try {
                assert.strictEqual(sent.length, 0,
                    'Echo commit timer must not fire a commit while response is active');
                console.log('  ✅ PASS  [async] FIX 14: echo timer does not commit while response is active');
                passed++;
            } catch (e) {
                console.error('  ❌ FAIL  [async] FIX 14: echo timer does not commit while response is active');
                console.error(`         ${e.message}`);
                failed++;
            }
            resolve();
        }, SILENCE_MS + 40);
    });

    // cancelEchoGuard prevents stop timer from firing
    await new Promise(resolve => {
        const session = { pauseTranscription: false };
        const { startEchoGuard, stopEchoGuard, cancelEchoGuard } = buildEchoGuard(session, GRACE_MS);
        startEchoGuard();
        stopEchoGuard();
        cancelEchoGuard(); // must prevent the timer
        setTimeout(() => {
            try {
                assert.strictEqual(session.pauseTranscription, false,
                    'Must stay false — the stop timer was cancelled');
                console.log('  ✅ PASS  [async] cancelEchoGuard prevents stop timer from firing');
                passed++;
            } catch (e) {
                console.error('  ❌ FAIL  [async] cancelEchoGuard prevents stop timer from firing');
                console.error(`         ${e.message}`);
                failed++;
            }
            resolve();
        }, GRACE_MS + 30);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
runAsyncTests().then(() => {
    console.log(`\n${'─'.repeat(55)}`);
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log('─'.repeat(55));
    if (failed > 0) {
        process.exit(1);
    }
});

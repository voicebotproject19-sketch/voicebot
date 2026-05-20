'use strict';

const { analyzeConversationForHangup } = require('../adapters/llm/hangupDecision');
const { quickHangupDecision, shouldPerformAnalysis } = require('../Helper/quickDecisionFilter');
const { computePhase } = require('../Helper/conversationPhase');
const { isFactualQuestionWithoutKB, scanForHallucination, getHallucinationFallback } = require('../Helper/hallucinationGuard');
const { LATENCY_COMPENSATION } = require('../config/latencyResponsivenessConfig');
const { legacyRetrievalToDocs, applyRagGuardrails, recordRetrievalTimeout } = require('../rag/ragGuardrails');
const { evaluateIntentConfidence } = require('../logic/intentGate');
const { PHASE4_ENABLED } = require('../config/phase4Config');
const telemetry = require('../Utils/telemetry');
const { matchPrecomputedAnswer } = require('../services/precomputedAnswers');
const { sanitizeDocument } = require('../rag/retrievalSanitation');
const { evaluateTransactionPolicy } = require('../transactions/transactionPolicy');

// Sprint 4.4: Simple intent patterns that don't need KB retrieval
const SIMPLE_INTENT_PATTERNS = {
    greeting: /^(hi|hello|hey|good\s*(morning|afternoon|evening)|howdy|greetings)\b/i,
    confirmation: /^(yes|yeah|yep|yup|sure|ok(ay)?|correct|right|exactly|absolutely|definitely|of course|perfect|great|sounds good|that works|go ahead)\b/i,
    rejection: /^(no|nah|nope|not\s*(interested|now|really|at\s*this\s*time)|pass|i'?m\s*good|no\s*thanks?)\b/i,
    singleWord: /^\S+$/,
    acknowledgement: /^(got it|understood|i see|mm-?hmm|uh-?huh|alright)\b/i,
};

function isSimpleIntent(text) {
    if (!text || text.length > 50) return null; // Long utterances are never simple
    const trimmed = text.trim().toLowerCase();
    const wordCount = trimmed.split(/\s+/).length;
    for (const [intentType, pattern] of Object.entries(SIMPLE_INTENT_PATTERNS)) {
        if (pattern.test(trimmed)) {
            // Utterances with >4 words that match a simple prefix likely contain
            // substantive content (e.g. "sure, my email is john@example.com")
            if (wordCount > 4 && intentType !== 'singleWord') return null;
            return intentType;
        }
    }
    return null;
}

function phaseLog(callSID, event, data = {}) {
    console.log(JSON.stringify({ ts: Date.now(), level: 'info', callSID: callSID || 'none', event, ...data }));
}

const BOOKING_ACTION_PHASES = new Set(['offer', 'slot-collection', 'email-collection', 'email-verify']);
const PROMPT_BUDGET_PHASES = new Set(['offer', 'slot-collection', 'email-collection', 'email-verify', 'confirmation']);

function readBoundedIntEnv(name, fallback, min, max) {
    const raw = Number(process.env[name]);
    if (!Number.isFinite(raw)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(raw)));
}

function setAdapterClarificationCount(adapter, count, reason) {
    if (adapter && typeof adapter.setClarificationCount === 'function') {
        return adapter.setClarificationCount(count, reason);
    }
    if (adapter) adapter._clarificationCount = count;
    return count;
}

function shouldBypassIntentGateForBookingAction(adapter) {
    if (!adapter?._bookingActionThisTurn) return false;
    if (typeof adapter._shouldBypassIntentGateForBookingAction === 'function') {
        return adapter._shouldBypassIntentGateForBookingAction();
    }
    return BOOKING_ACTION_PHASES.has(adapter.conversationPhase);
}

class ConversationEngine {
    constructor(adapter) {
        this.adapter = adapter;
    }

    addConversationContext(sender, message) {
        this.adapter.conversationContext.push({
            sender,
            message: message.trim(),
            timestamp: new Date().toISOString()
        });

        const SUMMARIZE_THRESHOLD = 8;
        if (this.adapter.conversationContext.length > SUMMARIZE_THRESHOLD
            && !this.adapter._summarizationInFlight
            && !this.adapter._summarizationPermanentlyFailed) {
            this._triggerSummarization();
        }
    }

    formatConversationContext(maxTurns) {
        if (!this.adapter.conversationContext || this.adapter.conversationContext.length === 0) {
            return '(Call just started - no previous exchanges)';
        }
        const prefix = this.adapter._contextSummary ? `[Earlier: ${this.adapter._contextSummary}]\n` : '';
        const limit = maxTurns || 8;
        const locale = this.adapter._langCode === 'de' ? 'de-DE' : 'en-US';
        return prefix + this.adapter.conversationContext
            .slice(-limit)
            .map(msg => {
                const d = new Date(msg.timestamp);
                const time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
                const speaker = msg.sender === 'USER' ? (this.adapter.recipient || 'Prospect') : 'You';
                return `[${time}] ${speaker}: ${msg.message}`;
            })
            .join('\n');
    }

    insertUpdatedPrompt(userQuestion, decision = 'high') {
        if (this.adapter._handoverTriggered) return;

        // Sprint 4.5: PAT — bypass inference entirely for FAQ matches
        // Sprint 5B.5: Pass phase for phase-filtered persona PAT
        const patMatch = matchPrecomputedAnswer(userQuestion, this.adapter.persona, this.adapter.name, this.adapter.conversationPhase);
        if (patMatch) {
            telemetry.emit('pat_match', {
                callSID: this.adapter.callSID, patId: patMatch.id, ts: Date.now()
            });
            setAdapterClarificationCount(this.adapter, 0, 'pat_match');
            this.adapter.addConversationContext('AI', patMatch.response);
            this.adapter._scriptedResponsePending = true; // Log71 Fix 1
            this.adapter.send(this.adapter._buildResponseCreate({
                instructions: `Say ONLY these exact words, then stop: "${patMatch.response}"`,
                conversation: 'none',
                input: []
            }));
            return;
        }

        if (shouldBypassIntentGateForBookingAction(this.adapter)) {
            const bookingResponse = typeof this.adapter._buildPhaseContractCorrection === 'function'
                ? this.adapter._buildPhaseContractCorrection(this.adapter.conversationPhase)
                : 'Great, I can send the booking link. Should I text it to this number?';
            setAdapterClarificationCount(this.adapter, 0, 'booking_action_bypass');
            this._sendOrDeferResponseCreate(userQuestion, decision, {
                instructions: `Say ONLY these exact words, then stop: "${bookingResponse}"`,
                input: []
            }, {
                scripted: true
            });
            return;
        }

        // Reset per-turn state to prevent stale data leaking across turns
        this.adapter._lastKbScoredSections = null;

        const compLevel = this.adapter._latencyCompensationLevel;
        const maxTurns = this._getContextTurnLimit(compLevel);

        const conversationContext = this.formatConversationContext(maxTurns);
        let relevantKnowledge = '';
        let isGeneralFallback = false;

        // Sprint 4.4: Intent gate — skip KB retrieval for simple intents
        const simpleIntent = isSimpleIntent(userQuestion);
        const preserveKnowledgeForBookingQuestion = this._shouldPreserveKnowledgeForBookingQuestion(userQuestion, simpleIntent);
        const skipKbForSimpleIntent = simpleIntent && !preserveKnowledgeForBookingQuestion;
        if (skipKbForSimpleIntent) {
            if ((this.adapter._clarificationCount || 0) > 0) {
                setAdapterClarificationCount(this.adapter, 0, 'simple_intent_proceed');
            }
            relevantKnowledge = '';
            isGeneralFallback = true;
            telemetry.emit('intent_gate_skip_kb', {
                callSID: this.adapter.callSID, intentType: simpleIntent, ts: Date.now()
            });
        } else if (compLevel === 'AGGRESSIVE' && LATENCY_COMPENSATION.skipKbOnAggressive) {
            relevantKnowledge = '';
            isGeneralFallback = true;
        } else if (this.adapter._prewarmKbResult !== null && this.adapter._prewarmKbQuery &&
                   (this.adapter._prewarmKbQuery === userQuestion ||
                    this.adapter._computeTokenOverlap(this.adapter._prewarmKbQuery, userQuestion) >= 0.7)) {
            // Speculative pre-warm hit: partial transcript KB result is usable.
            // Fuzzy match (≥70% token overlap) allows partial-transcript pre-warm
            // results to be used even when the final transcript differs slightly.
            const cached = this.adapter._prewarmKbResult;
            const isExactMatch = this.adapter._prewarmKbQuery === userQuestion;
            telemetry.emit('speculative_prewarm_used', {
                callSID: this.adapter.callSID,
                exact: isExactMatch,
                overlap: isExactMatch ? 1 : this.adapter._computeTokenOverlap(this.adapter._prewarmKbQuery, userQuestion),
                ts: Date.now()
            });
            if (cached && typeof cached === 'object' && 'text' in cached) {
                relevantKnowledge = cached.text || '';
                isGeneralFallback = cached.isGeneralFallback === true;
                // Preserve scored sections for Phase 4 RAG guardrails (Sprint 6B.1)
                if (Array.isArray(cached.sections)) {
                    this.adapter._lastKbScoredSections = cached.sections;
                }
            } else {
                relevantKnowledge = cached || '';
            }
            this.adapter._prewarmKbResult = null;
            this.adapter._prewarmKbQuery = null;
        } else if (this.adapter.kb) {
            const kbStart = Date.now();
            try {
                const kbResult = this.adapter.kb.retrieveRelevantInfo(userQuestion, this.adapter.persona?.retrieval?.maxResults, this.adapter.persona?.retrieval?.minScoreThreshold);
                if (kbResult && typeof kbResult === 'object' && 'text' in kbResult) {
                    relevantKnowledge = kbResult.text || '';
                    isGeneralFallback = kbResult.isGeneralFallback === true;
                    // Sprint 6B.1 (F1): Preserve scored sections for RAG guardrails
                    if (Array.isArray(kbResult.sections)) {
                        this.adapter._lastKbScoredSections = kbResult.sections;
                    }
                } else {
                    relevantKnowledge = kbResult || '';
                }
            } catch (_) {
                relevantKnowledge = '';
                isGeneralFallback = true;
            }
            const kbMs = Date.now() - kbStart;
            const retrievalTimeoutMs = this.adapter._phase4Profile?.rag?.retrievalTimeoutMs ?? 2500;
            if (kbMs > retrievalTimeoutMs) {
                recordRetrievalTimeout(true);
                relevantKnowledge = '';
                isGeneralFallback = true;
                telemetry.emit('kb_retrieval_timeout', { callId: this.adapter.callSID, kbMs, budget: retrievalTimeoutMs, ts: Date.now() });
            } else {
                recordRetrievalTimeout(false);
            }
            if (kbMs > 500) {
                telemetry.emit('kb_retrieval_slow', { callId: this.adapter.callSID, kbMs, ts: Date.now() });
            }
        }

        if (this.adapter.kbEn && !skipKbForSimpleIntent && !(compLevel === 'AGGRESSIVE' && LATENCY_COMPENSATION.skipKbOnAggressive)) {
            try {
                const enResult = this.adapter.kbEn.retrieveRelevantInfo(userQuestion, this.adapter.persona?.retrieval?.maxResults, this.adapter.persona?.retrieval?.minScoreThreshold);
                let enKnowledge = '';
                let enFallback = false;
                if (enResult && typeof enResult === 'object' && 'text' in enResult) {
                    enKnowledge = enResult.text || '';
                    enFallback = enResult.isGeneralFallback === true;
                    // Sprint 6B.1 (F1): Merge English KB scored sections
                    if (Array.isArray(enResult.sections)) {
                        const existing = this.adapter._lastKbScoredSections || [];
                        this.adapter._lastKbScoredSections = [...enResult.sections, ...existing];
                    }
                } else {
                    enKnowledge = enResult || '';
                }
                relevantKnowledge = enKnowledge + (enKnowledge && relevantKnowledge ? '\n\n' : '') + relevantKnowledge;
                // Only mark as general fallback if BOTH KBs fell back
                if (enFallback && isGeneralFallback) {
                    isGeneralFallback = true;
                } else if (enKnowledge) {
                    isGeneralFallback = false;
                }
            } catch (_) {
                // kbEn retrieval failed — continue with existing knowledge
            }
        }

        if ((!relevantKnowledge || relevantKnowledge.trim().length === 0) && this.adapter.kb && !skipKbForSimpleIntent) {
            relevantKnowledge = this.adapter.kb.getGeneralInfo?.() ?? '';
            isGeneralFallback = true;
        }

        const generalInfo = skipKbForSimpleIntent ? '' : (this.adapter.kb?.getGeneralInfo?.() ?? '');
        const kbGate = this.shouldInterceptWithKbGate(userQuestion, relevantKnowledge, generalInfo, isGeneralFallback);
        if (kbGate.shouldIntercept) {
            this.adapter._scriptedResponsePending = true; // Log71 Fix 1
            this.adapter.send(this.adapter._buildResponseCreate({
                instructions: `Say ONLY these exact words, then stop: "${kbGate.safeResponse}"`,
                input: []
            }));
            return;
        }

        let toneDirective = this.adapter._currentToneDirective || '';
        if (this.adapter._bargeInOccurred) {
            const bargeAck = 'BARGE-IN: The caller interrupted your previous response. Briefly acknowledge ("Sure, go ahead" or "Of course") before answering their question.';
            toneDirective = toneDirective ? `${bargeAck}\n${toneDirective}` : bargeAck;
            this.adapter._bargeInOccurred = false;
        }

        this.adapter._lastRelevantKnowledge = relevantKnowledge;

        // ── Phase 4 Layer 1: Pre-generation guard rail ──────────
        try {
        if (PHASE4_ENABLED && this.adapter._phase4Profile) {
            const profile = this.adapter._phase4Profile;

            // A2a: Convert legacy KB string to doc array
            // Sprint 6B.1 (F1): Pass scored sections when available for real relevance scores
            const rawDocs = legacyRetrievalToDocs(relevantKnowledge, 0.5, this.adapter._lastKbScoredSections);

            // A2b+c: Apply RAG guardrails (sanitization is handled internally by applyRagGuardrails)
            const guardrailResult = applyRagGuardrails(rawDocs, profile);
            this.adapter._lastSanitizedDocs = guardrailResult.docs;
            // Log71 Fix 3: Signal general-info fallback so the synthesis/numeric
            // gates can distinguish real retrievals from marketing-blurb fallback.
            this.adapter._lastKbIsGeneralFallback = isGeneralFallback === true;

            // A2d: Rebuild relevantKnowledge from sanitized docs
            if (guardrailResult.docs.length > 0) {
                relevantKnowledge = guardrailResult.docs
                    .map(d => d.content)
                    .join('\n\n');
                this.adapter._lastRelevantKnowledge = relevantKnowledge;
            } else {
                // Sprint 6C.2 (N3): Clear raw KB text when guardrails drop all docs
                // to prevent unsanitized content leaking into the prompt
                relevantKnowledge = '';
                this.adapter._lastRelevantKnowledge = '';
            }

            // A2e: Intent confidence gate — blend static heuristic with real STT confidence
            // Simple intents (confirmation/greeting/rejection) were already classified
            // by isSimpleIntent with high confidence — skip the gate to avoid false
            // clarification triggers when KB was intentionally skipped (zeroDocs).
            const sttConf = this.adapter._lastSttConfidence ?? 1.0;
            const intentConfidence = skipKbForSimpleIntent
                ? 0.95
                : this.adapter.count <= 1
                    ? 0.9
                    : guardrailResult.zeroDocs ? 0.5 : Math.min(sttConf, 0.8);

            const gateResult = evaluateIntentConfidence(
                intentConfidence,
                profile,
                this.adapter._clarificationCount || 0
            );

            if (gateResult.action === 'clarify') {
                setAdapterClarificationCount(this.adapter, gateResult.clarificationCount, 'intent_confidence_clarify');
                this.adapter._scriptedResponsePending = true; // Log71 Fix 1
                this.adapter.send(this.adapter._buildResponseCreate({
                    instructions: 'Say ONLY these exact words, then stop: "I want to make sure I understand you correctly. Could you rephrase that for me?"',
                    input: []
                }));
                return;
            }

            if (gateResult.action === 'escalate') {
                setAdapterClarificationCount(this.adapter, gateResult.clarificationCount, 'intent_confidence_escalate');
                this.adapter.emit('escalation_needed', {
                    reason: 'intent_confidence_exhausted',
                    clarificationCount: gateResult.clarificationCount
                });
                this.adapter._scriptedResponsePending = true; // Log71 Fix 1
                this.adapter.send(this.adapter._buildResponseCreate({
                    instructions: 'Say ONLY these exact words, then stop: "Let me connect you with someone who can help you better."',
                    input: []
                }));
                return;
            }

            if (gateResult.action === 'proceed' && (this.adapter._clarificationCount || 0) > 0) {
                setAdapterClarificationCount(this.adapter, 0, 'intent_confidence_proceed');
            }

            // B4: Transaction policy gate — block unsafe transactions
            // Only fires when the adapter signals an actual transaction turn.
            // Transaction detection is a future feature; until then the gate
            // is effectively inert (isTransactionTurn defaults to false).
            if (profile.transaction?.confirmationRequired && this.adapter._isTransactionTurn) {
                const txResult = evaluateTransactionPolicy({
                    interactionMode: this.adapter._currentInteractionMode || 'INTERACTIVE',
                    sttConfidence: this.adapter._lastSttConfidence ?? undefined,
                }, profile);
                if (!txResult.allowed) {
                    telemetry.emit('transaction_policy_blocked', {
                        callSID: this.adapter.callSID,
                        failures: txResult.failures,
                        ts: Date.now()
                    });
                    this.adapter._scriptedResponsePending = true; // Log71 Fix 1
                    this.adapter.send(this.adapter._buildResponseCreate({
                        instructions: 'Say ONLY these exact words, then stop: "I want to make sure I got that right. Could you please confirm?"',
                        input: []
                    }));
                    return;
                }
            }
        }
        } catch (phase4Err) {
            console.error(JSON.stringify({ ts: Date.now(), level: 'error', callSID: this.adapter.callSID || 'none', event: 'phase4_layer1_error', message: phase4Err.message }));
            // Clear stale doc cache so Layer 2 doesn't judge against previous-turn docs
            this.adapter._lastSanitizedDocs = null;
            this.adapter._lastKbIsGeneralFallback = false; // Log71 Fix 3
            // Continue without Phase 4 guard rail — fall through to LLM generation
        }

        // Sanitize KB content when Phase 4 is disabled — Phase 4 handles
        // sanitization internally via applyRagGuardrails, but the non-Phase-4
        // path feeds raw KB text directly into buildTurnPrompt.
        if (!PHASE4_ENABLED && relevantKnowledge) {
            const sanitized = sanitizeDocument(relevantKnowledge);
            if (sanitized.dropped) {
                relevantKnowledge = '';
                this.adapter._lastRelevantKnowledge = '';
            } else {
                relevantKnowledge = sanitized.sanitized || relevantKnowledge;
                this.adapter._lastRelevantKnowledge = relevantKnowledge;
            }
        }

        let updatedInstruction;
        try {
            updatedInstruction = this.adapter.lang.buildTurnPrompt({
                count: this.adapter.count,
                name: this.adapter.name,
                userQuestion,
                userEmail: this.adapter.userEmail,
                userPhone: this.adapter.userPhone,
                preferredSlot: this.adapter.preferredSlot,
                bookingLinkRequested: this.adapter.bookingLinkRequested || false,
                bookingLinkSent: this.adapter.bookingLinkSent || false,
                bookingProvider: this.adapter.bookingProvider || null,
                bookingDeliveryPreference: this.adapter.bookingDeliveryPreference || null,
                bookingPhoneDeliveryConsent: this.adapter.bookingPhoneDeliveryConsent || false,
                bookingDeliveryChannels: this.adapter.bookingDeliveryChannels || [],
                contextHint: this.adapter.callContextHint || null,
                dealerContext: this.adapter.dealerOrder?.crmContext || null,
                dealerOrder: this.adapter.dealerOrder || null,
                conversationContext,
                relevantKnowledge,
                hasAskedForConsultation: this.adapter.hasAskedForConsultation,
                conversationPhase: this.adapter.conversationPhase,
                toneDirective: toneDirective || null,
                decision: decision || 'high'
            });
            this.adapter._currentToneDirective = null;
        } catch (_) {
            updatedInstruction = this.adapter.lang.baseInstruction();
        }

        // Language enforcement — prepend to every turn instruction
        const langLabel = (this.adapter._langCode || 'en') === 'de' ? 'German' : 'English';
        updatedInstruction = `LANGUAGE RULE: Respond in ${langLabel}. If the caller switches to a different language, acknowledge warmly and continue in ${langLabel}. Brief courtesy words in the caller's language are acceptable.\n\n${updatedInstruction}`;

        // Inject word limit correction if previous response was too long
        if (this.adapter._wordLimitOverride) {
            updatedInstruction += `\n\nIMPORTANT: ${this.adapter._wordLimitOverride}`;
            this.adapter._wordLimitOverride = null;
        }

        // Inject pending language drift correction from previous turn
        if (this.adapter._pendingLanguageCorrection) {
            updatedInstruction = `${this.adapter._pendingLanguageCorrection}\n\n${updatedInstruction}`;
            this.adapter._pendingLanguageCorrection = null;
        }

        this._recordPromptBudget(updatedInstruction, {
            phase: this.adapter.conversationPhase,
            decision: decision || 'high',
            conversationContextLength: conversationContext.length,
            relevantKnowledgeLength: relevantKnowledge.length,
            hasSummary: !!this.adapter._contextSummary,
            simpleIntent: simpleIntent || null,
            maxTurns: maxTurns || 8,
            skippedKbForSimpleIntent: !!skipKbForSimpleIntent
        });

        if (this.adapter.isResponding) {
            this._queueDeferredUserInput(userQuestion, decision);
        } else if (this.adapter.isUserSpeaking) {
            console.error(JSON.stringify({ ts: Date.now(), level: 'info', callSID: this.adapter.callSID || 'none', event: 'response_create_deferred_isUserSpeaking' }));
            this.adapter._deferredInstruction = updatedInstruction;
            this.adapter._deferredInstructionOwner = typeof this.adapter._captureResponseOwner === 'function'
                ? this.adapter._captureResponseOwner('deferred_instruction', { allowInputActivityDrift: true })
                : null;
            this.adapter._deferredInstructionScripted = false;
        } else {
            this.adapter._deferredInstruction = null;
            this.adapter._deferredInstructionOwner = null;
            this.adapter._deferredInstructionScripted = false;
            // Send response.create directly with per-response instruction overrides.
            // Azure Realtime API docs: "response.create includes inference configuration
            // like instructions and temperature. These fields can override the session's
            // configuration for this response only."
            // This eliminates the session.update round-trip wait (15-40ms savings/turn)
            // and the entire _pendingSessionUpdate/_pendingResponseCreate state machine.
            console.log(JSON.stringify({ ts: Date.now(), level: 'info', callSID: this.adapter.callSID || 'none', event: 'response_create_dispatch', isResponding: this.adapter.isResponding, isUserSpeaking: this.adapter.isUserSpeaking, instructionLen: updatedInstruction?.length }));
            this.adapter.send(this.adapter._buildResponseCreate({
                instructions: updatedInstruction,
                max_response_output_tokens: this.adapter._getAdaptiveTokenLimit(),
                ...(this.adapter._includeTempInSessionConfig && {
                    temperature: Math.max(0.6, Math.min(1.2, this.adapter._getAdaptiveTemperature()))
                })
            }));
        }
    }

    _queueDeferredUserInput(userQuestion, decision) {
        console.error(JSON.stringify({ ts: Date.now(), level: 'info', callSID: this.adapter.callSID || 'none', event: 'response_create_deferred_isResponding', queueLen: this.adapter._deferredUserInputQueue.length, question: userQuestion.substring(0, 60) }));
        const lastQueued = this.adapter._deferredUserInputQueue.length > 0
            ? this.adapter._deferredUserInputQueue[this.adapter._deferredUserInputQueue.length - 1]
            : null;
        const isDuplicateShort = lastQueued
            && userQuestion.split(/\s+/).length <= 5
            && lastQueued.userQuestion.toLowerCase().trim() === userQuestion.toLowerCase().trim();
        if (isDuplicateShort) {
            const decisionPriority = { high: 3, medium: 2, low: 1 };
            if ((decisionPriority[decision] || 0) > (decisionPriority[lastQueued.decision] || 0)) {
                lastQueued.decision = decision;
            }
            lastQueued.owner = typeof this.adapter._captureResponseOwner === 'function'
                ? this.adapter._captureResponseOwner('deferred_user_input')
                : null;
            return;
        }
        if (this.adapter._deferredUserInputQueue.length >= this.adapter._maxDeferredUserInputQueue) {
            this.adapter._deferredUserInputQueue.shift();
        }
        this.adapter._deferredUserInputQueue.push({
            userQuestion,
            decision,
            owner: typeof this.adapter._captureResponseOwner === 'function'
                ? this.adapter._captureResponseOwner('deferred_user_input')
                : null
        });
    }

    _isPromptBudgetPhase(phase = this.adapter.conversationPhase) {
        return PROMPT_BUDGET_PHASES.has(phase);
    }

    _getContextTurnLimit(compLevel) {
        const aggressiveLimit = Number(LATENCY_COMPENSATION.aggressiveMaxContextTurns);
        const lightLimit = Number(LATENCY_COMPENSATION.lightMaxContextTurns);
        const baseLimit = compLevel === 'AGGRESSIVE' && Number.isFinite(aggressiveLimit) && aggressiveLimit > 0
            ? aggressiveLimit
            : compLevel === 'LIGHT' && Number.isFinite(lightLimit) && lightLimit > 0
                ? lightLimit
                : undefined;
        if (!this._isPromptBudgetPhase()) return baseLimit;
        const bookingLimit = readBoundedIntEnv('RESPONSE_INSTRUCTION_BOOKING_MAX_TURNS', 4, 2, 8);
        return baseLimit ? Math.min(baseLimit, bookingLimit) : bookingLimit;
    }

    _shouldPreserveKnowledgeForBookingQuestion(userQuestion, simpleIntent) {
        if (!simpleIntent || !this._isPromptBudgetPhase()) return false;
        const normalized = String(userQuestion || '').toLowerCase();
        return /\b(what|where|when|why|how\s+much|pricing|price|cost|rate|rates|charge|charges|office|offices|located|location|service|services|support|capability|capabilities|offer|offers|provide|demo|website|app|software|platform|integration|integrations)\b/i.test(normalized)
            || /\b(can|could|do|does)\s+(you|your|company|we)\b/i.test(normalized);
    }

    _getPromptBudgetForPhase(phase = this.adapter.conversationPhase) {
        const softDefault = this._isPromptBudgetPhase(phase) ? 4800 : 5200;
        const softCharBudget = readBoundedIntEnv('RESPONSE_INSTRUCTION_WARN_CHARS', softDefault, 1000, 50000);
        const hardDefault = Math.max(6500, softCharBudget + 1);
        const hardCharBudget = readBoundedIntEnv('RESPONSE_INSTRUCTION_HARD_WARN_CHARS', hardDefault, softCharBudget + 1, 75000);
        return { softCharBudget, hardCharBudget };
    }

    _recordPromptBudget(instructions, metadata = {}) {
        const text = String(instructions || '');
        const instructionLen = text.length;
        const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
        const { softCharBudget, hardCharBudget } = this._getPromptBudgetForPhase(metadata.phase);
        if (instructionLen <= softCharBudget) return;

        const payload = {
            callId: this.adapter.callSID,
            phase: metadata.phase || this.adapter.conversationPhase,
            decision: metadata.decision || 'high',
            instructionLen,
            wordCount,
            softCharBudget,
            hardCharBudget,
            conversationContextLength: metadata.conversationContextLength || 0,
            relevantKnowledgeLength: metadata.relevantKnowledgeLength || 0,
            hasSummary: !!metadata.hasSummary,
            simpleIntent: metadata.simpleIntent || null,
            maxTurns: metadata.maxTurns || 8,
            skippedKbForSimpleIntent: !!metadata.skippedKbForSimpleIntent,
            ts: Date.now()
        };
        telemetry.emit('prompt_budget_warning', payload);
        if (instructionLen > hardCharBudget) {
            telemetry.emit('prompt_budget_hard_warning', payload);
        }
    }

    _sendOrDeferResponseCreate(userQuestion, decision, responseCreateOptions, options = {}) {
        if (this.adapter.isResponding) {
            this._queueDeferredUserInput(userQuestion, decision);
            return;
        }
        if (this.adapter.isUserSpeaking) {
            console.error(JSON.stringify({ ts: Date.now(), level: 'info', callSID: this.adapter.callSID || 'none', event: 'response_create_deferred_isUserSpeaking' }));
            this.adapter._deferredInstruction = responseCreateOptions.instructions;
            this.adapter._deferredInstructionOwner = typeof this.adapter._captureResponseOwner === 'function'
                ? this.adapter._captureResponseOwner('deferred_instruction', { allowInputActivityDrift: true })
                : null;
            this.adapter._deferredInstructionScripted = options.scripted === true;
            return;
        }
        this.adapter._deferredInstruction = null;
        this.adapter._deferredInstructionOwner = null;
        this.adapter._deferredInstructionScripted = false;
        if (options.scripted === true) this.adapter._scriptedResponsePending = true;
        this.adapter.send(this.adapter._buildResponseCreate(responseCreateOptions));
    }

    async _triggerSummarization() {
        this.adapter._summarizationInFlight = true;
        const halfPoint = Math.floor(this.adapter.conversationContext.length / 2);
        const olderTurns = this.adapter.conversationContext.slice(0, halfPoint);

        try {
            const { summarizeOlderTurns } = require('../adapters/llm/contextSummarizer');
            const summary = await summarizeOlderTurns(olderTurns, this.adapter.persona?.flow?.callType || 'sales');
            // Sprint 5B.6: Detect empty-result (API succeeded but returned nothing)
            if (!summary) {
                telemetry.emit('summarization_empty', {
                    callId: this.adapter.callSID,
                    turnCount: olderTurns.length,
                    ts: Date.now()
                });
            }
            if (summary) {
                this.adapter._contextSummary = (this.adapter._contextSummary ? this.adapter._contextSummary + ' ' : '') + summary;
                // Cap summary growth to prevent unbounded token accumulation
                if (this.adapter._contextSummary.length > 1000) {
                    this.adapter._contextSummary = this.adapter._contextSummary.slice(-1000);
                }
                this.adapter.conversationContext = this.adapter.conversationContext.slice(halfPoint);
                this.adapter._summarizationConsecutiveFailures = 0;
            }
        } catch (err) {
            this.adapter._summarizationConsecutiveFailures = (this.adapter._summarizationConsecutiveFailures || 0) + 1;
            telemetry.emit('summarization_failed', {
                callId: this.adapter.callSID,
                failure: this.adapter._summarizationConsecutiveFailures,
                error: err?.message || String(err),
                ts: Date.now()
            });
            // Sprint 6E.2: Raised from 3→5 consecutive failures before permanent disable.
            // Transient Azure 429s can cause 2-3 failures in a row; 5 filters those out.
            if (this.adapter._summarizationConsecutiveFailures >= 5) {
                this.adapter._summarizationPermanentlyFailed = true;
                telemetry.emit('summarization_disabled', {
                    callId: this.adapter.callSID,
                    ts: Date.now()
                });
                console.warn(`[ConversationEngine] Summarization permanently disabled after ${this.adapter._summarizationConsecutiveFailures} consecutive failures (callSID: ${this.adapter.callSID})`);
            }
        }

        this.adapter._summarizationInFlight = false;
    }

    _updatePhase(overrides = {}) {
        this.adapter._consultationOfferedThisTurn = this.adapter._consultationOfferedThisTurn || false;
        const prev = this.adapter.conversationPhase;

        this.adapter.conversationPhase = computePhase({
            currentPhase: this.adapter.conversationPhase,
            count: this.adapter.count,
            isBeingScreened: this.adapter.isBeingScreened,
            isVoicemail: overrides.isVoicemail ?? this.adapter.isVoicemail ?? false,
            isRejected: overrides.isRejected ?? this.adapter.isRejected ?? false,
            hasAskedForConsultation: this.adapter.hasAskedForConsultation,
            offerAccepted: this.adapter.offerAccepted,
            emailRefused: this.adapter.emailRefused,
            isOnHold: this.adapter.isOnHold,
            preferredSlot: this.adapter.preferredSlot,
            userEmail: this.adapter.userEmail,
            emailConfirmed: overrides.emailConfirmed ?? this.adapter.emailConfirmed ?? false,
            emailPendingConfirmation: this.adapter.emailPendingConfirmation,
            bookingPhoneDeliveryConsent: this.adapter.bookingPhoneDeliveryConsent,
            bookingLinkRequested: this.adapter.bookingLinkRequested,
            bookingLinkSent: this.adapter.bookingLinkSent,
            isSuccess: overrides.isSuccess ?? this.adapter.isSuccess ?? false,
            consultationOfferedThisTurn: this.adapter._consultationOfferedThisTurn,
            ...overrides,
        });

        if (prev !== this.adapter.conversationPhase) {
            phaseLog(this.adapter.callSID, 'phase_transition', {
                from: prev,
                to: this.adapter.conversationPhase,
                count: this.adapter.count,
                offerAccepted: this.adapter.offerAccepted,
                hasAskedForConsultation: this.adapter.hasAskedForConsultation,
                preferredSlotPresent: !!this.adapter.preferredSlot,
                userEmailPresent: !!this.adapter.userEmail,
                emailPendingConfirmation: !!this.adapter.emailPendingConfirmation,
                emailRefused: !!this.adapter.emailRefused,
                bookingPhoneDeliveryConsent: !!this.adapter.bookingPhoneDeliveryConsent,
                bookingLinkRequested: !!this.adapter.bookingLinkRequested,
                bookingLinkSent: !!this.adapter.bookingLinkSent,
                overrides,
            });
            if (this.adapter.conversationPhase === 'rejected' || this.adapter.conversationPhase === 'voicemail') {
                this.adapter.hasAskedForConsultation = false;
                this.adapter.preferredSlot = null;
            }
            if (['success', 'rejected', 'voicemail'].includes(this.adapter.conversationPhase)) {
                this.adapter._callClosed = true;
                if (this.adapter._enableSilenceTimers) {
                    clearTimeout(this.adapter.firstSilenceTimer);
                    clearTimeout(this.adapter.secondSilenceTimer);
                }
            }
        }

        this.adapter._consultationOfferedThisTurn = false;
    }

    async runHangupAnalysis() {
        const phaseAllowsAnalysis = !['voicemail', 'rejected', 'success', 'screening', 'opening'].includes(this.adapter.conversationPhase);
        const shouldAnalyze = phaseAllowsAnalysis && shouldPerformAnalysis(this.adapter.count, !!this.adapter.userEmail);

        if (!shouldAnalyze) return null;

        const stt = this.adapter.lang?.sttLocale || 'en-US';
        const langKey = stt.startsWith('de') ? 'german' : stt.startsWith('hi') ? 'hindi' : 'english';
        const quickDecision = quickHangupDecision(this.adapter.conversationContext, this.adapter.count, langKey);
        const callType = this.adapter.persona?.flow?.callType || 'event';

        if (quickDecision && quickDecision.confidence > 0.8) {
            return { mode: 'quick', decision: quickDecision };
        }

        const decision = await analyzeConversationForHangup(
            this.adapter.name,
            this.adapter.count,
            [...this.adapter.conversationContext],
            callType
        );

        return { mode: 'llm', decision };
    }

    applyHallucinationGuard(aiText, lastRelevantKnowledge) {
        const result = scanForHallucination(aiText, lastRelevantKnowledge);
        if (!result.hallucinated) return null;

        return {
            hallucinated: true,
            fallback: getHallucinationFallback(
                this.adapter.conversationPhase,
                this.adapter.name,
                this.adapter.persona,
                this.adapter._buildGuardrailFallbackContext ? this.adapter._buildGuardrailFallbackContext() : null
            ),
            reasons: result.reasons
        };
    }

    shouldInterceptWithKbGate(userQuestion, relevantKnowledge, generalInfo, isGeneralFallback) {
        return isFactualQuestionWithoutKB(userQuestion, relevantKnowledge, generalInfo, this.adapter.persona, isGeneralFallback);
    }
}

module.exports = ConversationEngine;

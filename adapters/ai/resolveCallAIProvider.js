'use strict';

const { getPersonaLanguage } = require('../../personas/registry');

function normalize(name) {
    if (!name || typeof name !== 'string') return null;
    return name.trim().toLowerCase();
}

function fromPersona(personaId, language) {
    if (!personaId || !language) return null;
    try {
        const { persona, lang } = getPersonaLanguage(personaId, language);
        return normalize(lang.aiProvider || persona.aiProvider || null);
    } catch (_) {
        return null;
    }
}

function resolveCallAIProvider({ requestedAIProvider, personaId, language, envDefault }) {
    const request = normalize(requestedAIProvider);
    if (request) return request;

    const personaChoice = fromPersona(personaId, language);
    if (personaChoice) return personaChoice;

    return normalize(envDefault) || 'azure-realtime';
}

module.exports = { resolveCallAIProvider };

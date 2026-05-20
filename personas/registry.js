'use strict';

/**
 * @file registry.js
 * Persona registry — auto-loads every persona file in this directory and
 * exposes lookup, validation, and listing functions used by:
 *
 *   - MainController.js   (upfront validation at POST /api/call)
 *   - RealtimeServiceTwilio.initialize()
 *   - RealtimeServicePlivo.initialize()
 *   - Routes.js           (GET /api/personas)
 *
 * ─── ADDING A NEW PERSONA ────────────────────────────────────────────────────
 * Drop a new .js file in /personas/ that exports an object with an `id` field.
 * The registry picks it up automatically on next server start. No other changes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');

// ─── Load all persona files ───────────────────────────────────────────────────

/** @type {Map<string, import('./_schema').PersonaConfig>} */
const personas = new Map();

(function loadPersonas() {
    const dir = __dirname;
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch (err) {
        // Should never happen — __dirname always exists.
        console.error('[PersonaRegistry] Failed to read personas directory:', err.message);
        return;
    }

    files.forEach(file => {
        // Skip the registry itself, type-definition files (underscore prefix), non-JS files.
        if (file === 'registry.js' || file.startsWith('_') || !file.endsWith('.js')) return;

        const filePath = path.join(dir, file);
        let mod;
        try {
            mod = require(filePath);
        } catch (err) {
            // Syntax error or bad require inside persona file — fail loudly at boot.
            console.error(`[PersonaRegistry] Failed to load persona file "${file}":`, err.message);
            throw err; // Re-throw: a broken persona file must prevent the server from starting.
        }

        if (!mod || typeof mod !== 'object' || !mod.id) {
            console.warn(`[PersonaRegistry] Skipping "${file}" — no "id" field exported.`);
            return;
        }

        const normalizedId = mod.id.toLowerCase();

        if (personas.has(normalizedId)) {
            // Two files declaring the same id is a configuration error.
            console.error(`[PersonaRegistry] Duplicate persona id "${mod.id}" from file "${file}". The first loaded file wins.`);
            return;
        }

        personas.set(normalizedId, Object.freeze(mod));
        console.log(`[PersonaRegistry] Loaded persona "${normalizedId}" (${Object.keys(mod.languages || {}).join(', ')})`);
    });
})();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get a persona config by ID (case-insensitive).
 *
 * @param {string} personaId
 * @returns {import('./_schema').PersonaConfig}
 * @throws {Error} with a descriptive message listing available personas
 */
function getPersona(personaId) {
    if (!personaId || typeof personaId !== 'string') {
        throw new Error(
            `Invalid persona ID "${personaId}". ` +
            `Available: ${[...personas.keys()].join(', ')}`
        );
    }
    const key    = personaId.toLowerCase().trim();
    const persona = personas.get(key);
    if (!persona) {
        throw new Error(
            `Unknown persona "${personaId}". ` +
            `Available: ${[...personas.keys()].join(', ')}`
        );
    }
    return persona;
}

/**
 * Get a persona and its language-specific config together.
 * This is the primary entry point for RealtimeService.initialize().
 *
 * @param {string} personaId  - e.g. 'company-sales'
 * @param {string} langCode   - ISO 639-1 code, e.g. 'en', 'de'
 * @returns {{ persona: import('./_schema').PersonaConfig, lang: import('./_schema').PersonaLanguageConfig }}
 * @throws {Error} with descriptive message if persona or language not found
 */
function getPersonaLanguage(personaId, langCode) {
    const persona = getPersona(personaId);

    if (!langCode || typeof langCode !== 'string') {
        throw new Error(
            `Invalid language code "${langCode}" for persona "${personaId}". ` +
            `Available: ${Object.keys(persona.languages).join(', ')}`
        );
    }
    const key  = langCode.toLowerCase().trim();
    const lang = persona.languages[key];
    if (!lang) {
        throw new Error(
            `Persona "${personaId}" does not support language "${langCode}". ` +
            `Available: ${Object.keys(persona.languages).join(', ')}`
        );
    }
    return { persona, lang };
}

/**
 * List all registered personas with their IDs, names, companies, and languages.
 * Used by GET /api/personas.
 *
 * @returns {Array<{ id: string, name: string, company: string, languages: string[] }>}
 */
function listPersonas() {
    return [...personas.values()].map(p => ({
        id:        p.id,
        name:      p.name,
        company:   p.company,
        languages: Object.keys(p.languages),
    }));
}

/**
 * Legacy compatibility: converts the old single-string `language` parameter
 * (from EnglishBot.html, GermanBot.html, MiamiEnglishBot.html) to the new
 * { persona, language } pair.
 *
 * Returns null if the string doesn't match a known legacy value — the caller
 * should then reject with a 400 and instruct use of the new parameters.
 *
 * @param {string} legacyLanguage - e.g. "english", "german", "Miami English"
 * @returns {{ persona: string, language: string } | null}
 */
function resolveLegacy(legacyLanguage) {
    if (!legacyLanguage || typeof legacyLanguage !== 'string') return null;
    return LEGACY_MAP[legacyLanguage.toLowerCase().trim()] || null;
}

/**
 * Maps old language string values → new { persona, language } pairs.
 * Add entries here when old callers use language values not yet in this map.
 */
const LEGACY_MAP = {
    'english':       { persona: 'company-sales', language: 'en' },
    'german':        { persona: 'company-sales', language: 'de' },
    'miami english': { persona: 'exed-webinar',       language: 'en' },
};

module.exports = { getPersona, getPersonaLanguage, listPersonas, resolveLegacy };

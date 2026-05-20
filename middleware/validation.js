'use strict';

const { z } = require('zod');

// ── /api/call request body ──────────────────────────────────────────────────
const policyChannelSchema = z.object({
    enabled: z.boolean().optional(),
    language: z.string().max(10).optional(),
    text: z.string().max(500).optional(),
}).strict().optional();

const callBodySchema = z.object({
    phoneNumber: z.string()
        .regex(/^\+\d{8,15}$/, 'Must be E.164 format: +<country><number>'),
    name: z.string().min(1).max(200),
    persona: z.string().max(100).optional(),
    language: z.string().max(50).optional(),
    contextHint: z.string().max(2000).nullable().optional(),
    aiProvider: z.string().max(50).nullable().optional(),
    policyConfig: z.object({
        voicemail: policyChannelSchema,
        screening: policyChannelSchema,
        fallbackLanguage: z.string().max(10).optional(),
        isoCountryCode: z.string().regex(/^\d{1,4}$/).optional(),
    }).strict().nullable().optional(),
});

// ── Validation middleware factory ────────────────────────────────────────────
function validateBody(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            const errors = result.error.issues.map(i => ({
                path: i.path.join('.'),
                message: i.message,
            }));
            return res.status(400).json({ error: 'Validation failed', details: errors });
        }
        req.body = result.data;
        next();
    };
}

module.exports = { callBodySchema, validateBody };

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const Router = express.Router();
const MainController = require('../Controller/MainController');
const { apiAuth, bookingWebhookAuth, twilioWebhookAuth, plivoWebhookAuth } = require('../middleware/auth');
const { callBodySchema, validateBody } = require('../middleware/validation');

const callLimiter = rateLimit({
	windowMs: 60 * 1000,
	limit: 10,
	standardHeaders: 'draft-8',
	legacyHeaders: false
});

// Stricter rate limit for the public demobot proxy (no API key required)
const demobotLimiter = rateLimit({
	windowMs: 60 * 1000,
	limit: 5,
	standardHeaders: 'draft-8',
	legacyHeaders: false
});


//API to handle call
Router.post('/api/call', callLimiter, apiAuth, validateBody(callBodySchema), MainController.call);

//API to list available personas
Router.get('/api/personas', apiAuth, MainController.listPersonas);

//Handle incoming request for TWILIO
Router.post('/incoming-twilio', twilioWebhookAuth, MainController.incoming_twilio);

//Handle incoming request for Plivo (answer URL — returns Stream XML)
Router.post('/incoming-plivo', plivoWebhookAuth, MainController.incoming_plivo);

//Handle Plivo status callbacks (separate from answer URL)
Router.post('/plivo-status', plivoWebhookAuth, MainController.plivoStatusWebhook);

//Handle booking provider webhook callbacks (Calendly / Microsoft Bookings)
Router.get('/booking-webhook', MainController.bookingWebhookValidation);
Router.post('/booking-webhook', bookingWebhookAuth, MainController.bookingWebhook);

//Handle Plivo call transfer to human agent
Router.get('/transfer-plivo', plivoWebhookAuth, MainController.transfer_plivo);
Router.post('/transfer-plivo', plivoWebhookAuth, MainController.transfer_plivo);
Router.post('/plivo-transfer-action', plivoWebhookAuth, MainController.plivoTransferAction);
Router.post('/plivo-transfer-events', plivoWebhookAuth, MainController.plivoTransferEvents);
Router.get('/plivo-transfer-confirm', plivoWebhookAuth, MainController.plivoTransferConfirm);
Router.post('/plivo-transfer-confirm', plivoWebhookAuth, MainController.plivoTransferConfirm);

//Fallback webhook for TWILIO status
Router.post('/twilio-status', twilioWebhookAuth, MainController.twilioStatus);
Router.post('/twilio-transfer-action', twilioWebhookAuth, MainController.twilioTransferAction);

//Health to check server status
Router.get('/health', MainController.health);

// Authenticated workflow readiness for durable workflow/outbox operations.
Router.get('/api/workflow/readiness', apiAuth, MainController.workflowReadiness);
Router.get('/api/workflow/actions', apiAuth, MainController.workflowActionSamples);
Router.get('/api/workflow/reconciliation', apiAuth, MainController.workflowReconciliation);
Router.get('/api/workflow/release-evidence', apiAuth, MainController.workflowReleaseEvidence);
Router.post('/api/workflow/release-evidence', apiAuth, MainController.workflowReleaseEvidence);
Router.post('/api/workflow/reconciliation/requeue', apiAuth, MainController.workflowReconciliationRequeue);
Router.post('/api/workflow/actions/:id/requeue', apiAuth, MainController.workflowActionRequeue);

// Client config — no auth so public HTML pages can check if backend is configured.
// Does NOT return secrets (API key is injected server-side via /api/demobot/call).
Router.get('/api/config', MainController.getConfig);

// Public demobot proxy — forwards call to the configured DEMOBOT backend,
// injecting the API key server-side so it is never exposed to the browser.
Router.post('/api/demobot/call', demobotLimiter, validateBody(callBodySchema), MainController.demobotCall);

//Serve english bot html
Router.get('/english/Call', MainController.serveEnglishHtml);

//Serve german bot html
Router.get('/german/Call', MainController.serveGermanHtml);

//Serve miami english html
Router.get('/miami-english/Call', MainController.serveMiamiEnglishHtml);

//serve conversations html
Router.get('/conversations', apiAuth, MainController.serveConversationHtml)

//get all users
Router.get('/users', apiAuth, MainController.getUsers);

//get all conversation
Router.get('/user/conversations', apiAuth, MainController.getConversations);

module.exports = Router;
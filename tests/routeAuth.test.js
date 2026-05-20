'use strict';

describe('Routes auth configuration', () => {
    let Routes;

    // Extract route definitions from the router stack
    function getRouteMiddlewares(method, path) {
        const layer = Routes.stack.find(l => {
            if (!l.route) return false;
            return l.route.path === path && l.route.methods[method];
        });
        if (!layer) return [];
        return layer.route.stack.map(s => s.name);
    }

    beforeAll(() => {
        // Stub MainController methods so require doesn't fail
        jest.mock('../Controller/MainController', () => {
            const handler = (req, res) => res.json({});
            return {
                call: handler, listPersonas: handler, incoming_twilio: handler,
                incoming_plivo: handler, plivoStatusWebhook: handler,
                bookingWebhook: handler, bookingWebhookValidation: handler,
                transfer_plivo: handler, plivoTransferAction: handler,
                plivoTransferEvents: handler, plivoTransferConfirm: handler,
                twilioStatus: handler, twilioTransferAction: handler, health: handler,
                workflowReadiness: handler, workflowActionSamples: handler, workflowActionRequeue: handler,
                workflowReconciliation: handler, workflowReconciliationRequeue: handler,
                workflowReleaseEvidence: handler,
                getConfig: handler, serveEnglishHtml: handler, serveGermanHtml: handler,
                serveMiamiEnglishHtml: handler, serveConversationHtml: handler,
                getUsers: handler, getConversations: handler, demobotCall: handler,
            };
        });
        jest.mock('../middleware/auth', () => ({
            apiAuth: function apiAuth(req, res, next) { next(); },
            bookingWebhookAuth: function bookingWebhookAuth(req, res, next) { next(); },
            twilioWebhookAuth: function twilioWebhookAuth(req, res, next) { next(); },
            plivoWebhookAuth: function plivoWebhookAuth(req, res, next) { next(); },
            wsSafeAuth: (fn) => fn,
        }));
        jest.mock('express-rate-limit', () => ({
            rateLimit: () => function callLimiter(req, res, next) { next(); }
        }));
        Routes = require('../Routes/Routes');
    });

    test('/api/config does NOT have apiAuth (public)', () => {
        expect(getRouteMiddlewares('get', '/api/config')).not.toContain('apiAuth');
    });

    test('/api/demobot/call does NOT have apiAuth (public proxy)', () => {
        expect(getRouteMiddlewares('post', '/api/demobot/call')).not.toContain('apiAuth');
    });

    test('/conversations has apiAuth middleware', () => {
        expect(getRouteMiddlewares('get', '/conversations')).toContain('apiAuth');
    });

    test('/users has apiAuth middleware', () => {
        expect(getRouteMiddlewares('get', '/users')).toContain('apiAuth');
    });

    test('/user/conversations has apiAuth middleware', () => {
        expect(getRouteMiddlewares('get', '/user/conversations')).toContain('apiAuth');
    });

    test('/health does NOT have apiAuth (public)', () => {
        expect(getRouteMiddlewares('get', '/health')).not.toContain('apiAuth');
    });

    test('/api/workflow/readiness has apiAuth middleware', () => {
        expect(getRouteMiddlewares('get', '/api/workflow/readiness')).toContain('apiAuth');
    });

    test('/api/workflow/actions has apiAuth middleware', () => {
        expect(getRouteMiddlewares('get', '/api/workflow/actions')).toContain('apiAuth');
    });

    test('/api/workflow/reconciliation has apiAuth middleware', () => {
        expect(getRouteMiddlewares('get', '/api/workflow/reconciliation')).toContain('apiAuth');
    });

    test('/api/workflow/release-evidence GET has apiAuth middleware', () => {
        expect(getRouteMiddlewares('get', '/api/workflow/release-evidence')).toContain('apiAuth');
    });

    test('/api/workflow/release-evidence POST has apiAuth middleware', () => {
        expect(getRouteMiddlewares('post', '/api/workflow/release-evidence')).toContain('apiAuth');
    });

    test('/api/workflow/reconciliation/requeue has apiAuth middleware', () => {
        expect(getRouteMiddlewares('post', '/api/workflow/reconciliation/requeue')).toContain('apiAuth');
    });

    test('/api/workflow/actions/:id/requeue has apiAuth middleware', () => {
        expect(getRouteMiddlewares('post', '/api/workflow/actions/:id/requeue')).toContain('apiAuth');
    });

    test('/booking-webhook POST has bookingWebhookAuth middleware', () => {
        expect(getRouteMiddlewares('post', '/booking-webhook')).toContain('bookingWebhookAuth');
    });

    test('/booking-webhook validation GET is public', () => {
        expect(getRouteMiddlewares('get', '/booking-webhook')).not.toContain('bookingWebhookAuth');
    });

    test('/transfer-plivo POST has plivoWebhookAuth middleware', () => {
        expect(getRouteMiddlewares('post', '/transfer-plivo')).toContain('plivoWebhookAuth');
    });

    test('/transfer-plivo GET has plivoWebhookAuth middleware', () => {
        expect(getRouteMiddlewares('get', '/transfer-plivo')).toContain('plivoWebhookAuth');
    });

    test.each(['/plivo-transfer-action', '/plivo-transfer-events', '/plivo-transfer-confirm'])('%s POST has plivoWebhookAuth middleware', (route) => {
        expect(getRouteMiddlewares('post', route)).toContain('plivoWebhookAuth');
    });

    test('/twilio-transfer-action POST has twilioWebhookAuth middleware', () => {
        expect(getRouteMiddlewares('post', '/twilio-transfer-action')).toContain('twilioWebhookAuth');
    });

    test('/plivo-transfer-confirm GET has plivoWebhookAuth middleware', () => {
        expect(getRouteMiddlewares('get', '/plivo-transfer-confirm')).toContain('plivoWebhookAuth');
    });
});

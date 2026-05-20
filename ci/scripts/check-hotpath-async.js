/**
 * ENTERPRISE HOT PATH ASYNC ENFORCEMENT (AST-BASED, CONTRACT-DRIVEN)
 *
 * - Hot path is defined by event names in ci/contracts/hotpath-contract.js
 * - Object names (ws, realtimeService, adapter, etc.) are irrelevant
 * - Any .on('<event>') where event is in HOTPATH_EVENT_NAMES is protected
 * - Enforces: no async, no await, no Promise chains, no direct IO
 */

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

// 🔒 Import governance contract
const { HOTPATH_EVENT_NAMES } = require('../contracts/hotpath-contract');

// Validate contract integrity
if (!Array.isArray(HOTPATH_EVENT_NAMES)) {
  console.error('❌ HOTPATH_EVENT_NAMES contract missing or invalid.');
  process.exit(1);
}

const ROOT = path.resolve(process.cwd());
const APP_PATH = path.join(ROOT, 'app.js');

// 🔒 Blocked direct IO identifiers (expand cautiously)
const BLOCKED_CALLEES = [
  'insertConversation',
  'analyzeConversationForHangup',
  'db',
  'query'
];

if (!fs.existsSync(APP_PATH)) {
  console.error('❌ app.js not found at project root.');
  process.exit(1);
}

const code = fs.readFileSync(APP_PATH, 'utf8');

let ast;
try {
  ast = acorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    locations: true
  });
} catch (err) {
  console.error('❌ Failed to parse app.js:', err.message);
  process.exit(1);
}

let violation = false;

function isHotPathCall(node) {
  if (node.type !== 'CallExpression') return false;
  if (!node.callee || node.callee.type !== 'MemberExpression') return false;
  if (!node.callee.property || node.callee.property.name !== 'on') return false;

  const firstArg = node.arguments[0];
  if (!firstArg || firstArg.type !== 'Literal') return false;

  return HOTPATH_EVENT_NAMES.includes(firstArg.value);
}

function validateHotPath(handlerNode, eventName) {
  const target = handlerNode.type === 'BlockStatement' ? handlerNode : { type: 'Program', body: [handlerNode] };

  walk.simple(target, {
    AwaitExpression(node) {
      report(node, 'AwaitExpression', eventName);
    },
    FunctionDeclaration(node) {
      if (node.async) {
        report(node, 'async function inside hot-path', eventName);
      }
    },
    FunctionExpression(node) {
      if (node.async) {
        report(node, 'async function expression inside hot-path', eventName);
      }
    },
    ArrowFunctionExpression(node) {
      if (node.async) {
        report(node, 'async arrow function inside hot-path', eventName);
      }
    },
    NewExpression(node) {
      if (node.callee && node.callee.name === 'Promise') {
        report(node, 'new Promise()', eventName);
      }
    },
    CallExpression(node) {
      // Timers are allowed if guarded by epoch/turn safety in app.js
      // Do not treat timers themselves as async violations

      // Block Promise.resolve or similar Promise static usage
      if (
        node.callee.type === 'MemberExpression' &&
        node.callee.object &&
        node.callee.object.name === 'Promise'
      ) {
        report(node, 'Promise static usage', eventName);
      }

      // Block Promise chain usage (.then / .catch / .finally)
      if (
        node.callee.type === 'MemberExpression' &&
        node.callee.property &&
        ['then', 'catch', 'finally'].includes(node.callee.property.name)
      ) {
        report(node, `Promise.${node.callee.property.name} chain`, eventName);
      }

      // Block direct blocked identifiers
      if (
        node.callee.type === 'Identifier' &&
        BLOCKED_CALLEES.includes(node.callee.name)
      ) {
        report(node, `Blocked IO call: ${node.callee.name}`, eventName);
      }

      // Only block clearly external IO patterns (avoid false positives like getPauseMs/getDefaultPolicyConfig)
      if (
        node.callee.type === 'Identifier' &&
        /^(fetch|query|insert|update|delete|write)/i.test(node.callee.name)
      ) {
        report(node, `Potential external IO call: ${node.callee.name}`, eventName);
      }

      // Block blocked object member calls (e.g., db.query)
      if (
        node.callee.type === 'MemberExpression' &&
        node.callee.object &&
        node.callee.object.name &&
        BLOCKED_CALLEES.includes(node.callee.object.name)
      ) {
        report(node, `Blocked IO call on ${node.callee.object.name}`, eventName);
      }
    }
  });
}

function report(node, reason, eventName) {
  const eventInfo = eventName ? ` event="${eventName}"` : '';
  console.error(`❌ Hot-path violation (${reason})${eventInfo} at line ${node.loc.start.line}`);
  violation = true;
}

walk.simple(ast, {
  CallExpression(node) {
    if (isHotPathCall(node)) {
      const eventName = node.arguments[0].value;
      const handler = node.arguments[1];
      if (!handler) return;

      if (
        handler.type === 'FunctionExpression' ||
        handler.type === 'ArrowFunctionExpression'
      ) {
        if (handler.async) {
          report(handler, 'async handler declaration', eventName);
        }

        if (handler.body) {
          validateHotPath(handler.body, eventName);
        }
      }
    }
  }
});

if (violation) {
  console.error('\n🚫 Hot-path async/IO detected. Remove async behavior from hot-path handlers.');
  process.exit(1);
}

console.log('✔ Enterprise hot-path validation passed (contract-driven enforcement).');
process.exit(0);
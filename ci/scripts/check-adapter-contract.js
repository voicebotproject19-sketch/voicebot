/**
 * ADAPTER CONTRACT ENFORCEMENT — HARDENED v2.1 (Class-Only)
 *
 * Strict Rules:
 *  - Adapters MUST export a class
 *  - No factory exports
 *  - No plain object exports
 *  - No static methods
 *  - No instance-field (arrow) methods
 *  - No constructor execution
 *  - Full prototype-chain validation
 *  - Exact surface parity with contract
 */

const path = require('path');
const fs = require('fs');
const ROOT = process.cwd();
const CONTRACT_PATH = path.join(ROOT, 'adapters/ai/AIProviderContract.js');
const ADAPTERS_DIR = path.join(ROOT, 'adapters/ai');
const BASE_ADAPTER_PATH = path.join(ADAPTERS_DIR, 'BaseRealtimeAdapter.js');

function fail(message) {
  console.error(`❌ Adapter contract violation: ${message}`);
  process.exit(1);
}

function loadContract() {
  if (!fs.existsSync(CONTRACT_PATH)) {
    fail('Adapter contract file missing.');
  }
  return require(CONTRACT_PATH);
}

function getAdapterFiles() {
  return fs.readdirSync(ADAPTERS_DIR)
    .filter(file =>
      file.endsWith('.js') &&
      ![
        'AIProviderContract.js',
        'BaseRealtimeAdapter.js',
        'resolveAIProvider.js',
        'resolveCallAIProvider.js',
        'modelRouter.js'
      ].includes(file)
    );
}

function collectPrototypeMethods(klass) {
  const methods = new Set();
  let proto = klass.prototype;

  while (proto && proto !== Object.prototype) {
    Object.getOwnPropertyNames(proto)
      .filter(name => name !== 'constructor')
      .forEach(name => methods.add(name));

    proto = Object.getPrototypeOf(proto);
  }

  return Array.from(methods);
}

function collectStaticMethods(klass) {
  return Object.getOwnPropertyNames(klass)
    .filter(name =>
      !['length', 'name', 'prototype'].includes(name)
    );
}

function validateSurface(methods, contract, adapterName) {
  const required = contract.requiredMethods;

  for (const method of required) {
    if (!methods.includes(method)) {
      fail(`${adapterName} missing required method: ${method}`);
    }
  }
}

function validateArity(prototype, contract, adapterName) {
  for (const method of contract.requiredMethods) {
    const expected = contract.methodSignatures[method];
    const fn = prototype[method];

    if (typeof fn !== 'function') {
      fail(`${adapterName} method ${method} is not a function`);
    }

    if (fn.length !== expected) {
      fail(`${adapterName} method ${method} expects ${expected} params but has ${fn.length}`);
    }
  }
}

function detectInstanceFieldMethods(adapterPath) {
  const content = fs.readFileSync(adapterPath, 'utf8');

  const arrowMethodPattern = /\n\s*[a-zA-Z0-9_]+\s*=\s*\([^)]*\)\s*=>/;

  if (arrowMethodPattern.test(content)) {
    fail(`${path.basename(adapterPath)} contains instance-field arrow methods which are not allowed`);
  }
}

function validateAdapter(adapterPath, contract) {
  const adapterName = path.basename(adapterPath);
  const exported = require(adapterPath);
  const BaseRealtimeAdapter = require(BASE_ADAPTER_PATH);

  if (typeof exported !== 'function' || !exported.prototype) {
    fail(`${adapterName} must export a class`);
  }

  if (!(exported.prototype instanceof BaseRealtimeAdapter)) {
    fail(`${adapterName} must extend BaseRealtimeAdapter`);
  }

  detectInstanceFieldMethods(adapterPath);

  const prototypeMethods = collectPrototypeMethods(exported);
  const staticMethods = collectStaticMethods(exported);

  if (staticMethods.length > 0) {
    fail(`${adapterName} contains static methods which are not allowed: ${staticMethods.join(', ')}`);
  }

  validateSurface(prototypeMethods, contract, adapterName);
  validateArity(exported.prototype, contract, adapterName);

  for (const getterName of contract.requiredGetters || []) {
    let proto = exported.prototype;
    let descriptor = null;
    while (proto && proto !== Object.prototype && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(proto, getterName);
      proto = Object.getPrototypeOf(proto);
    }
    if (!descriptor || typeof descriptor.get !== 'function') {
      fail(`${adapterName} missing required getter: ${getterName}`);
    }
  }
}

function run() {
  const contract = loadContract();
  const adapters = getAdapterFiles();

  if (adapters.length === 0) {
    fail('No adapters found.');
  }

  for (const file of adapters) {
    const fullPath = path.join(ADAPTERS_DIR, file);
    validateAdapter(fullPath, contract);
  }

  console.log('✔ Adapter contract validation passed (class-only hardened v2.1).');
  process.exit(0);
}

run();
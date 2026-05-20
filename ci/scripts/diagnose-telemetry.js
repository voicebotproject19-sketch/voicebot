#!/usr/bin/env node
/**
 * TELEMETRY LAYER DIAGNOSTIC SCRIPT
 * 
 * This script performs a comprehensive diagnostic analysis of the telemetry layer,
 * verifying connectivity and operational status between source agents and backend infrastructure.
 * 
 * Usage: node ci/scripts/diagnose-telemetry.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  bright: '\x1b[1m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(80));
  log(title, 'bright');
  console.log('='.repeat(80));
}

function logSubsection(title) {
  console.log('\n' + '-'.repeat(60));
  log(title, 'cyan');
  console.log('-'.repeat(60));
}

function checkPass(message) {
  log(`✓ ${message}`, 'green');
}

function checkFail(message, details = '') {
  log(`✗ ${message}`, 'red');
  if (details) {
    log(`  Details: ${details}`, 'yellow');
  }
}

function checkWarn(message, details = '') {
  log(`⚠ ${message}`, 'yellow');
  if (details) {
    log(`  Details: ${details}`, 'yellow');
  }
}

// Diagnostic results tracking
const diagnostics = {
  passed: [],
  failed: [],
  warnings: [],
  info: []
};

function recordResult(type, message, details = '') {
  diagnostics[type].push({ message, details });
}

// ============================================================================
// SECTION 1: Configuration Verification
// ============================================================================
function checkConfiguration() {
  logSection('1. TELEMETRY CONFIGURATION VERIFICATION');
  
  // Check .env file
  logSubsection('1.1 Environment File Check');
  const envPath = path.join(process.cwd(), '.env');
  const envExamplePath = path.join(process.cwd(), '.env.example');
  
  if (fs.existsSync(envPath)) {
    checkPass('.env file exists');
    recordResult('passed', '.env file exists');
    
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const envLines = envContent.split('\n');
    
    log('\n  Current environment variables:');
    envLines.forEach(line => {
      if (line.trim() && !line.startsWith('#')) {
        const [key, value] = line.split('=');
        if (key && value) {
          // Mask sensitive values
          const maskedValue = key.toLowerCase().includes('key') || 
                             key.toLowerCase().includes('secret') || 
                             key.toLowerCase().includes('token') ||
                             key.toLowerCase().includes('connection')
                             ? '***MASKED***' 
                             : value;
          log(`    ${key}=${maskedValue}`);
        }
      }
    });
  } else {
    checkFail('.env file does not exist');
    recordResult('failed', '.env file does not exist');
    
    if (fs.existsSync(envExamplePath)) {
      checkWarn('.env.example exists but .env is missing');
      recordResult('warnings', '.env.example exists but .env is missing');
      log('\n  To create .env from .env.example, run:');
      log('    copy .env.example .env', 'cyan');
    }
  }
  
  // Check telemetry-specific environment variables
  logSubsection('1.2 Telemetry Environment Variables');
  
  const telemetryEnabled = process.env.VOICEBOT_TELEMETRY === 'true';
  const azureMonitorConnString = process.env.AZURE_MONITOR_CONNECTION_STRING;
  const appInsightsConnString = process.env.APPINSIGHTS_CONNECTION_STRING;
  
  if (telemetryEnabled) {
    checkPass('VOICEBOT_TELEMETRY is set to "true"');
    recordResult('passed', 'VOICEBOT_TELEMETRY enabled');
  } else {
    checkFail('VOICEBOT_TELEMETRY is not set to "true"', `Current: ${process.env.VOICEBOT_TELEMETRY || 'undefined'}`);
    recordResult('failed', 'VOICEBOT_TELEMETRY not enabled', `Current: ${process.env.VOICEBOT_TELEMETRY || 'undefined'}`);
  }
  
  if (azureMonitorConnString) {
    checkPass('AZURE_MONITOR_CONNECTION_STRING is set');
    recordResult('passed', 'AZURE_MONITOR_CONNECTION_STRING configured');
    
    // Validate connection string format
    if (azureMonitorConnString.includes('InstrumentationKey=') || 
        azureMonitorConnString.includes('IngestionEndpoint=')) {
      checkPass('AZURE_MONITOR_CONNECTION_STRING format appears valid');
      recordResult('passed', 'AZURE_MONITOR_CONNECTION_STRING format valid');
    } else {
      checkWarn('AZURE_MONITOR_CONNECTION_STRING format may be invalid');
      recordResult('warnings', 'AZURE_MONITOR_CONNECTION_STRING format may be invalid');
    }
  } else {
    checkFail('AZURE_MONITOR_CONNECTION_STRING is not set');
    recordResult('failed', 'AZURE_MONITOR_CONNECTION_STRING not configured');
  }
  
  if (appInsightsConnString) {
    checkPass('APPINSIGHTS_CONNECTION_STRING is set (legacy fallback)');
    recordResult('passed', 'APPINSIGHTS_CONNECTION_STRING configured (legacy)');
  } else {
    log('  ℹ APPINSIGHTS_CONNECTION_STRING not set (optional - Azure Monitor preferred)', 'cyan');
    recordResult('info', 'APPINSIGHTS_CONNECTION_STRING not configured');
  }
}

// ============================================================================
// SECTION 2: Dependency Verification
// ============================================================================
function checkDependencies() {
  logSection('2. TELEMETRY DEPENDENCY VERIFICATION');
  
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  
  if (!fs.existsSync(packageJsonPath)) {
    checkFail('package.json not found');
    recordResult('failed', 'package.json not found');
    return;
  }
  
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  const dependencies = packageJson.dependencies || {};
  const devDependencies = packageJson.devDependencies || {};
  const allDeps = { ...dependencies, ...devDependencies };
  
  logSubsection('2.1 Required Telemetry Packages');
  
  const requiredPackages = [
    '@azure/monitor-opentelemetry',
    '@opentelemetry/sdk-trace-node',
    '@opentelemetry/sdk-trace-base',
    '@opentelemetry/api',
    'applicationinsights'
  ];
  
  requiredPackages.forEach(pkg => {
    if (allDeps[pkg]) {
      checkPass(`${pkg} is installed (${allDeps[pkg]})`);
      recordResult('passed', `${pkg} installed`, `Version: ${allDeps[pkg]}`);
    } else {
      checkFail(`${pkg} is not installed`);
      recordResult('failed', `${pkg} not installed`);
    }
  });
  
  // Check node_modules
  logSubsection('2.2 Node Modules Check');
  const nodeModulesPath = path.join(process.cwd(), 'node_modules');
  
  if (fs.existsSync(nodeModulesPath)) {
    checkPass('node_modules directory exists');
    recordResult('passed', 'node_modules directory exists');
    
    requiredPackages.forEach(pkg => {
      const pkgPath = path.join(nodeModulesPath, pkg);
      if (fs.existsSync(pkgPath)) {
        checkPass(`${pkg} module is present in node_modules`);
        recordResult('passed', `${pkg} module present`);
      } else {
        checkFail(`${pkg} module is missing from node_modules`);
        recordResult('failed', `${pkg} module missing`);
        log(`    Run: npm install ${pkg}`, 'cyan');
      }
    });
  } else {
    checkFail('node_modules directory does not exist');
    recordResult('failed', 'node_modules directory missing');
    log('    Run: npm install', 'cyan');
  }
}

// ============================================================================
// SECTION 3: Telemetry Agent Initialization Status
// ============================================================================
function checkTelemetryAgentInitialization() {
  logSection('3. TELEMETRY AGENT INITIALIZATION STATUS');
  
  logSubsection('3.1 Telemetry Module Loading');
  
  try {
    const telemetryPath = path.join(process.cwd(), 'Utils/telemetry.js');
    if (fs.existsSync(telemetryPath)) {
      checkPass('Utils/telemetry.js exists');
      recordResult('passed', 'Utils/telemetry.js exists');
    } else {
      checkFail('Utils/telemetry.js not found');
      recordResult('failed', 'Utils/telemetry.js missing');
      return;
    }
    
    const telemetryEventsPath = path.join(process.cwd(), 'Utils/telemetryEvents.js');
    if (fs.existsSync(telemetryEventsPath)) {
      checkPass('Utils/telemetryEvents.js exists');
      recordResult('passed', 'Utils/telemetryEvents.js exists');
    } else {
      checkFail('Utils/telemetryEvents.js not found');
      recordResult('failed', 'Utils/telemetryEvents.js missing');
      return;
    }
    
    const loggerPath = path.join(process.cwd(), 'Utils/logger.js');
    if (fs.existsSync(loggerPath)) {
      checkPass('Utils/logger.js exists');
      recordResult('passed', 'Utils/logger.js exists');
    } else {
      checkFail('Utils/logger.js not found');
      recordResult('failed', 'Utils/logger.js missing');
      return;
    }
    
    // Try to load telemetry modules
    logSubsection('3.2 Telemetry Module Import Test');
    
    try {
      const telemetryEvents = require(telemetryEventsPath);
      checkPass('telemetryEvents module loaded successfully');
      recordResult('passed', 'telemetryEvents module loaded');
      log(`    Defined events: ${telemetryEvents.size}`, 'cyan');
      recordResult('info', 'Telemetry events count', `${telemetryEvents.size} events defined`);
    } catch (err) {
      checkFail('Failed to load telemetryEvents module', err.message);
      recordResult('failed', 'telemetryEvents module load failed', err.message);
    }
    
    try {
      const telemetryAdapterPath = path.join(process.cwd(), 'adapters/telemetry/telemetryAdapter.js');
      const telemetryAdapter = require(telemetryAdapterPath);
      checkPass('telemetryAdapter module loaded successfully');
      recordResult('passed', 'telemetryAdapter module loaded');
    } catch (err) {
      checkFail('Failed to load telemetryAdapter module', err.message);
      recordResult('failed', 'telemetryAdapter module load failed', err.message);
    }
    
    try {
      const azureTelemetryAdapterPath = path.join(process.cwd(), 'adapters/telemetry/azureTelemetryAdapter.js');
      const azureTelemetryAdapter = require(azureTelemetryAdapterPath);
      checkPass('azureTelemetryAdapter module loaded successfully');
      recordResult('passed', 'azureTelemetryAdapter module loaded');
    } catch (err) {
      checkFail('Failed to load azureTelemetryAdapter module', err.message);
      recordResult('failed', 'azureTelemetryAdapter module load failed', err.message);
    }
    
  } catch (err) {
    checkFail('Error checking telemetry modules', err.message);
    recordResult('failed', 'Telemetry module check failed', err.message);
  }
}

// ============================================================================
// SECTION 4: Network Connectivity to Azure Monitor
// ============================================================================
function checkNetworkConnectivity() {
  logSection('4. NETWORK CONNECTIVITY TO AZURE MONITOR');
  
  const azureMonitorConnString = process.env.AZURE_MONITOR_CONNECTION_STRING;
  
  if (!azureMonitorConnString) {
    checkWarn('Cannot test network connectivity - AZURE_MONITOR_CONNECTION_STRING not set');
    recordResult('warnings', 'Network connectivity test skipped - no connection string');
    return;
  }
  
  logSubsection('4.1 Connection String Parsing');
  
  // Parse connection string to extract endpoints
  const params = {};
  azureMonitorConnString.split(';').forEach(part => {
    const [key, value] = part.split('=');
    if (key && value) {
      params[key] = value;
    }
  });
  
  const ingestionEndpoint = params['IngestionEndpoint'] || 'https://dc.services.visualstudio.com';
  const instrumentationKey = params['InstrumentationKey'];
  
  if (instrumentationKey) {
    checkPass('InstrumentationKey found in connection string');
    recordResult('passed', 'InstrumentationKey present');
    log(`    Key: ${instrumentationKey.substring(0, 8)}...`, 'cyan');
  } else {
    checkFail('InstrumentationKey not found in connection string');
    recordResult('failed', 'InstrumentationKey missing');
  }
  
  log(`  Ingestion Endpoint: ${ingestionEndpoint}`, 'cyan');
  recordResult('info', 'Ingestion endpoint', ingestionEndpoint);
  
  logSubsection('4.2 DNS Resolution');
  
  const url = new URL(ingestionEndpoint);
  const hostname = url.hostname;
  
  log(`  Resolving hostname: ${hostname}`, 'cyan');
  
  const dns = require('dns');
  
  dns.lookup(hostname, (err, address) => {
    if (err) {
      checkFail('DNS resolution failed', err.message);
      recordResult('failed', 'DNS resolution failed', err.message);
    } else {
      checkPass(`DNS resolution successful: ${address}`);
      recordResult('passed', 'DNS resolution successful', address);
    }
    
    logSubsection('4.3 TCP Connection Test');
    
    const net = require('net');
    const port = url.protocol === 'https:' ? 443 : 80;
    
    const socket = net.createConnection({ host: hostname, port: port }, () => {
      checkPass(`TCP connection to ${hostname}:${port} successful`);
      recordResult('passed', 'TCP connection successful', `${hostname}:${port}`);
      socket.destroy();
      
      logSubsection('4.4 HTTPS Endpoint Test');
      
      if (url.protocol === 'https:') {
        const options = {
          hostname: hostname,
          port: 443,
          path: '/v2/track',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-json-stream'
          },
          timeout: 10000
        };
        
        const req = https.request(options, (res) => {
          checkPass(`HTTPS endpoint responded with status: ${res.statusCode}`);
          recordResult('passed', 'HTTPS endpoint accessible', `Status: ${res.statusCode}`);
          res.resume();
        });
        
        req.on('error', (err) => {
          checkWarn('HTTPS endpoint test failed (may require authentication)', err.message);
          recordResult('warnings', 'HTTPS endpoint test failed', err.message);
          log('  This is expected if authentication is required', 'cyan');
        });
        
        req.on('timeout', () => {
          req.destroy();
          checkWarn('HTTPS endpoint request timed out');
          recordResult('warnings', 'HTTPS endpoint timeout');
        });
        
        // Send a minimal test payload
        req.write(JSON.stringify({ test: 'diagnostic' }));
        req.end();
      }
    });
    
    socket.on('error', (err) => {
      checkFail(`TCP connection to ${hostname}:${port} failed`, err.message);
      recordResult('failed', 'TCP connection failed', err.message);
      log('  Possible causes:', 'yellow');
      log('    - Firewall blocking outbound connections', 'yellow');
      log('    - Network connectivity issues', 'yellow');
      log('    - Proxy configuration required', 'yellow');
    });
  });
}

// ============================================================================
// SECTION 5: System Logs and File System Check
// ============================================================================
function checkSystemLogs() {
  logSection('5. SYSTEM LOGS AND FILE SYSTEM CHECK');
  
  logSubsection('5.1 Logs Directory');
  
  const logsDir = path.join(process.cwd(), 'logs');
  
  if (fs.existsSync(logsDir)) {
    checkPass('logs directory exists');
    recordResult('passed', 'logs directory exists');
    
    const stats = fs.statSync(logsDir);
    log(`  Permissions: ${stats.mode.toString(8)}`, 'cyan');
    log(`  Created: ${stats.birthtime}`, 'cyan');
    log(`  Modified: ${stats.mtime}`, 'cyan');
    
    // Check if directory is writable
    try {
      const testFile = path.join(logsDir, '.write-test');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      checkPass('logs directory is writable');
      recordResult('passed', 'logs directory writable');
    } catch (err) {
      checkFail('logs directory is not writable', err.message);
      recordResult('failed', 'logs directory not writable', err.message);
    }
  } else {
    checkFail('logs directory does not exist');
    recordResult('failed', 'logs directory missing');
    log('  The logger module will create this directory on initialization', 'cyan');
    recordResult('info', 'logs directory will be created on init');
  }
  
  logSubsection('5.2 Telemetry Log Files');
  
  const logFiles = [
    'logs/voicebot-events.jsonl',
    'logs/voicebot-events.jsonl.*'
  ];
  
  let foundLogs = false;
  
  try {
    if (fs.existsSync(logsDir)) {
      const files = fs.readdirSync(logsDir);
      const telemetryLogs = files.filter(f => f.startsWith('voicebot-events.jsonl'));
      
      if (telemetryLogs.length > 0) {
        checkPass(`Found ${telemetryLogs.length} telemetry log file(s)`);
        recordResult('passed', 'Telemetry log files found', `${telemetryLogs.length} file(s)`);
        foundLogs = true;
        
        telemetryLogs.forEach(logFile => {
          const logPath = path.join(logsDir, logFile);
          const logStats = fs.statSync(logPath);
          const sizeMB = (logStats.size / (1024 * 1024)).toFixed(2);
          log(`    ${logFile}: ${sizeMB} MB, modified ${logStats.mtime.toISOString()}`, 'cyan');
        });
      } else {
        checkWarn('No telemetry log files found in logs directory');
        recordResult('warnings', 'No telemetry log files found');
        log('  This is expected if telemetry has not been enabled or no events have been emitted', 'cyan');
      }
    }
  } catch (err) {
    checkFail('Error checking log files', err.message);
    recordResult('failed', 'Log file check failed', err.message);
  }
  
  // Sample log content if available
  if (foundLogs) {
    logSubsection('5.3 Log File Content Sample');
    
    try {
      const mainLog = path.join(logsDir, 'voicebot-events.jsonl');
      if (fs.existsSync(mainLog)) {
        const content = fs.readFileSync(mainLog, 'utf-8');
        const lines = content.trim().split('\n');
        
        if (lines.length > 0) {
          checkPass(`Log file contains ${lines.length} event(s)`);
          recordResult('passed', 'Log file contains events', `${lines.length} events`);
          
          // Show first few events
          const sampleSize = Math.min(3, lines.length);
          log(`  First ${sampleSize} event(s):`, 'cyan');
          
          for (let i = 0; i < sampleSize; i++) {
            try {
              const event = JSON.parse(lines[i]);
              log(`    [${i + 1}] ${event.eventType} at ${new Date(event.timestamp).toISOString()}`, 'cyan');
              if (event.callId) {
                log(`        Call ID: ${event.callId}`, 'cyan');
              }
            } catch (err) {
              log(`    [${i + 1}] (parse error)`, 'yellow');
            }
          }
        } else {
          checkWarn('Log file exists but is empty');
          recordResult('warnings', 'Log file empty');
        }
      }
    } catch (err) {
      checkFail('Error reading log file content', err.message);
      recordResult('failed', 'Log file read failed', err.message);
    }
  }
}

// ============================================================================
// SECTION 6: Telemetry Data Generation Validation
// ============================================================================
function checkTelemetryDataGeneration() {
  logSection('6. TELEMETRY DATA GENERATION VALIDATION');
  
  logSubsection('6.1 Telemetry Event Definitions');
  
  const telemetryEventsPath = path.join(process.cwd(), 'Utils/telemetryEvents.js');
  
  try {
    const EVENTS = require(telemetryEventsPath);
    
    checkPass(`Telemetry events defined: ${EVENTS.size} events`);
    recordResult('passed', 'Telemetry events defined', `${EVENTS.size} events`);
    
    log('  Event types:', 'cyan');
    const eventList = Array.from(EVENTS);
    eventList.forEach((event, index) => {
      log(`    ${index + 1}. ${event}`, 'cyan');
    });
    
    // Check for critical events
    logSubsection('6.2 Critical Event Coverage');
    
    const criticalEvents = [
      'turn_created',
      'turn_snapshot',
      'speech_started',
      'speech_emitted',
      'speech_completed',
      'hangup_triggered',
      'turn_closed',
      'degradation_state_transition'
    ];
    
    let missingCritical = [];
    
    criticalEvents.forEach(event => {
      if (EVENTS.has(event)) {
        checkPass(`Critical event defined: ${event}`);
        recordResult('passed', `Critical event: ${event}`);
      } else {
        checkFail(`Critical event missing: ${event}`);
        recordResult('failed', `Critical event missing: ${event}`);
        missingCritical.push(event);
      }
    });
    
    if (missingCritical.length === 0) {
      checkPass('All critical events are defined');
      recordResult('passed', 'All critical events defined');
    }
    
  } catch (err) {
    checkFail('Failed to validate telemetry events', err.message);
    recordResult('failed', 'Telemetry events validation failed', err.message);
  }
  
  // Check telemetry emit function
  logSubsection('6.3 Telemetry Emit Function');
  
  const telemetryPath = path.join(process.cwd(), 'Utils/telemetry.js');
  
  try {
    const telemetry = require(telemetryPath);
    
    if (typeof telemetry.emit === 'function') {
      checkPass('telemetry.emit function is available');
      recordResult('passed', 'telemetry.emit function available');
    } else {
      checkFail('telemetry.emit function is not available');
      recordResult('failed', 'telemetry.emit function missing');
    }
  } catch (err) {
    checkFail('Failed to load telemetry module', err.message);
    recordResult('failed', 'Telemetry module load failed', err.message);
  }
}

// ============================================================================
// SECTION 7: Application Integration Check
// ============================================================================
function checkApplicationIntegration() {
  logSection('7. APPLICATION INTEGRATION CHECK');
  
  logSubsection('7.1 Telemetry Import in app.js');
  
  const appJsPath = path.join(process.cwd(), 'app.js');
  
  if (!fs.existsSync(appJsPath)) {
    checkFail('app.js not found');
    recordResult('failed', 'app.js missing');
    return;
  }
  
  const appContent = fs.readFileSync(appJsPath, 'utf-8');
  
  if (appContent.includes("require('./Utils/telemetry')")) {
    checkPass('Telemetry module is imported in app.js');
    recordResult('passed', 'Telemetry imported in app.js');
  } else {
    checkFail('Telemetry module is not imported in app.js');
    recordResult('failed', 'Telemetry not imported in app.js');
  }
  
  // Check for telemetry.emit calls
  logSubsection('7.2 Telemetry Event Emission in app.js');
  
  const emitMatches = appContent.match(/telemetry\.emit\s*\(/g);
  
  if (emitMatches && emitMatches.length > 0) {
    checkPass(`Found ${emitMatches.length} telemetry.emit() calls in app.js`);
    recordResult('passed', 'Telemetry emit calls found', `${emitMatches.length} calls`);
  } else {
    checkWarn('No telemetry.emit() calls found in app.js');
    recordResult('warnings', 'No telemetry emit calls in app.js');
  }
  
  // Check for logger.init() call
  logSubsection('7.3 Logger Initialization');
  
  if (appContent.includes('logger.init') || appContent.includes('telemetryAdapter.init')) {
    checkPass('Logger initialization code present in app.js');
    recordResult('passed', 'Logger initialization present');
  } else {
    checkWarn('Logger initialization not explicitly called in app.js');
    recordResult('warnings', 'Logger initialization not explicit');
    log('  Logger.init() is called automatically on first emit() when telemetry is enabled', 'cyan');
  }
}

// ============================================================================
// SECTION 8: Summary and Recommendations
// ============================================================================
function printSummary() {
  logSection('DIAGNOSTIC SUMMARY');
  
  console.log('\n' + '='.repeat(80));
  log('RESULTS OVERVIEW', 'bright');
  console.log('='.repeat(80));
  
  console.log(`\n  ${colors.green}✓ Passed: ${diagnostics.passed.length}${colors.reset}`);
  console.log(`  ${colors.red}✗ Failed: ${diagnostics.failed.length}${colors.reset}`);
  console.log(`  ${colors.yellow}⚠ Warnings: ${diagnostics.warnings.length}${colors.reset}`);
  console.log(`  ${colors.cyan}ℹ Info: ${diagnostics.info.length}${colors.reset}`);
  
  if (diagnostics.failed.length > 0) {
    console.log('\n' + '-'.repeat(80));
    log('CRITICAL ISSUES REQUIRING ATTENTION:', 'red');
    console.log('-'.repeat(80));
    
    diagnostics.failed.forEach((item, index) => {
      console.log(`\n  ${index + 1}. ${item.message}`);
      if (item.details) {
        console.log(`     ${colors.yellow}${item.details}${colors.reset}`);
      }
    });
  }
  
  if (diagnostics.warnings.length > 0) {
    console.log('\n' + '-'.repeat(80));
    log('WARNINGS:', 'yellow');
    console.log('-'.repeat(80));
    
    diagnostics.warnings.forEach((item, index) => {
      console.log(`\n  ${index + 1}. ${item.message}`);
      if (item.details) {
        console.log(`     ${colors.yellow}${item.details}${colors.reset}`);
      }
    });
  }
  
  console.log('\n' + '='.repeat(80));
  log('RECOMMENDATIONS', 'bright');
  console.log('='.repeat(80));
  
  const recommendations = [];
  
  // Check for common issues
  if (!process.env.VOICEBOT_TELEMETRY || process.env.VOICEBOT_TELEMETRY !== 'true') {
    recommendations.push({
      priority: 'CRITICAL',
      action: 'Enable telemetry by setting VOICEBOT_TELEMETRY=true in .env file'
    });
  }
  
  if (!process.env.AZURE_MONITOR_CONNECTION_STRING) {
    recommendations.push({
      priority: 'CRITICAL',
      action: 'Configure AZURE_MONITOR_CONNECTION_STRING in .env file'
    });
  }
  
  if (!fs.existsSync(path.join(process.cwd(), '.env'))) {
    recommendations.push({
      priority: 'HIGH',
      action: 'Create .env file from .env.example: copy .env.example .env'
    });
  }
  
  if (!fs.existsSync(path.join(process.cwd(), 'node_modules'))) {
    recommendations.push({
      priority: 'HIGH',
      action: 'Install dependencies: npm install'
    });
  }
  
  if (recommendations.length === 0) {
    log('\n  ✓ All critical checks passed! Telemetry layer appears to be properly configured.', 'green');
  } else {
    recommendations.forEach((rec, index) => {
      const priorityColor = rec.priority === 'CRITICAL' ? 'red' : 'yellow';
      console.log(`\n  ${index + 1}. [${rec.priority}] ${rec.action}`);
    });
  }
  
  console.log('\n' + '='.repeat(80));
  log('NEXT STEPS', 'bright');
  console.log('='.repeat(80));
  
  console.log('\n  1. Address all CRITICAL and HIGH priority recommendations above');
  console.log('  2. Restart the application: npm start or npm run dev');
  console.log('  3. Trigger some telemetry events by making test calls');
  console.log('  4. Check logs/voicebot-events.jsonl for generated telemetry data');
  console.log('  5. Verify data appears in Azure Monitor dashboard');
  
  console.log('\n' + '='.repeat(80));
  log('For detailed troubleshooting, see:', 'cyan');
  console.log('  - docs/rate-limit-implementation-guide.md');
  console.log('  - docs/openai-rate-limit-analysis.md');
  console.log('='.repeat(80) + '\n');
}

// ============================================================================
// Main Execution
// ============================================================================
function main() {
  console.log('\n' + '='.repeat(80));
  log('VOICEBOT TELEMETRY LAYER DIAGNOSTIC', 'bright');
  log('Comprehensive Connectivity and Operational Status Analysis', 'cyan');
  console.log('='.repeat(80));
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log('='.repeat(80));
  
  // Load environment variables from .env if it exists
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
  }
  
  // Run all diagnostic sections
  checkConfiguration();
  checkDependencies();
  checkTelemetryAgentInitialization();
  checkSystemLogs();
  checkTelemetryDataGeneration();
  checkApplicationIntegration();
  
  // Network connectivity is asynchronous
  setTimeout(() => {
    checkNetworkConnectivity();
    
    // Print summary after async operations complete
    setTimeout(() => {
      printSummary();
      console.log(`\n  Completed: ${new Date().toISOString()}`);
      console.log('='.repeat(80) + '\n');
    }, 3000);
  }, 100);
}

// Run diagnostics
main();

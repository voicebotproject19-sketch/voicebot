const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '../..')
const appPath = path.join(repoRoot, 'app.js')

if (!fs.existsSync(appPath)) {
  console.log('✔ app.js not found, skipping socket-close emission check')
  process.exit(0)
}

const code = fs.readFileSync(appPath, 'utf8')

let errors = []

/*
----------------------------------------
RULE 1
No sendAudioDirect inside ws.close block
----------------------------------------
*/

const closeBlocks = [
  ...code.matchAll(/ws\.on\(['"]close['"],\s*(?:function|\(.*?\)\s*=>)\s*{([\s\S]*?)}/g)
]

for (const block of closeBlocks) {

  const body = block[1]

  if (/sendAudioDirect\s*\(/.test(body)) {
    errors.push(
      'sendAudioDirect found inside websocket close handler'
    )
  }
}

/*
----------------------------------------
RULE 2
Timers must guard against closed socket
----------------------------------------
*/

const timerMatches = [...code.matchAll(/setTimeout\s*\(/g)]

for (const match of timerMatches) {

  const start = match.index

  // inspect a deterministic window after the timer declaration
  const windowStart = start
  const windowEnd = Math.min(code.length, start + 1000)
  const body = code.slice(windowStart, windowEnd)

  if (!body.includes('sendAudioDirect')) continue

  const guarded =
    /assertAudioSafe\s*\(/.test(body) ||
    /assertTurnActive\s*\(/.test(body) ||
    /isClosed\s*\)/.test(body) ||
    body.includes('turnState.isClosed') ||
    body.includes('edgeSession.isClosed')

  if (!guarded) {
    errors.push(
      'Timer emits audio without websocket/epoch guard'
    )
  }
}

/*
----------------------------------------
RULE 3
close handler must mark session closed
----------------------------------------
*/

const closeGuard =
  code.includes('turnState.isClosed = true') ||
  code.includes('edgeSession.isClosed = true')

if (!closeGuard) {
  errors.push(
    'Websocket close handler does not mark session closed'
  )
}

/*
----------------------------------------
RULE 4
sendAudioDirect must have guard BEFORE it
----------------------------------------
*/

const emitters = [...code.matchAll(/sendAudioDirect\s*\(/g)]

for (const e of emitters) {

  const idx = e.index
  const guardWindowStart = Math.max(0, idx - 400)
  const before = code.slice(guardWindowStart, idx)

  const guarded =
    /assertAudioSafe\s*\(/.test(before) ||
    /assertTurnActive\s*\(/.test(before) ||
    /isClosed\s*\)/.test(before) ||
    before.includes('turnState.isClosed') ||
    before.includes('edgeSession.isClosed')

  if (!guarded) {
    errors.push(`Audio emission missing guard near index ${idx}`)
  }
}

/*
----------------------------------------
RULE 5
Detect nested async audio emissions
----------------------------------------
*/

const nestedEmitterMatches = [...code.matchAll(/setTimeout[\s\S]{0,1200}?sendAudioDirect\s*\(/g)]

for (const match of nestedEmitterMatches) {

  const segment = match[0]

  const guarded =
    /assertAudioSafe\s*\(/.test(segment) ||
    /assertTurnActive\s*\(/.test(segment) ||
    /isClosed\s*\)/.test(segment)

  if (!guarded) {
    errors.push(
      'Nested async audio emission missing guard'
    )
  }
}

/*
----------------------------------------
RESULT
----------------------------------------
*/

if (errors.length > 0) {

  console.error('\n❌ Audio emission possible after websocket close\n')

  errors.forEach(e => console.error(' -', e))

  process.exit(1)
}

console.log('✔ No post-close audio emission risk detected')
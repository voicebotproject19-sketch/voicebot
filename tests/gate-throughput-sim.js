// Gate throughput simulation: old vs new Plivo config with inverted energy profile
function simulate(config, label) {
  let sf = 0, sent = 0, dropped = 0, total = 0;
  let speechSent = 0, speechDropped = 0;

  // 900 frames = 18 seconds at 50 frames/sec (20ms/frame)
  for (let i = 0; i < 900; i++) {
    total++;
    const t = i * 20; // ms
    let energy;

    // Energy profile modeled from actual log voicebot-out 52.log
    if (t < 2000)       energy = 0.73 + Math.random() * 0.10;  // early silence
    else if (t < 9000)  energy = 0.75 + Math.random() * 0.08;  // silence baseline 0.75-0.83
    else if (t < 11000) energy = 0.53 + Math.random() * 0.09;  // USER SPEECH (energy drops!)
    else if (t < 13000) energy = 0.60 + Math.random() * 0.10;  // speech trailing off
    else if (t < 17000) energy = 0.75 + Math.random() * 0.07;  // silence
    else                energy = 0.54 + Math.random() * 0.08;  // USER SPEECH again

    sf++;
    let shouldSend = sf < config.silenceFramesThreshold;
    if (config.energyOverrideThreshold != null && energy > config.energyOverrideThreshold) shouldSend = true;
    if (config.maxSilenceFailsafe != null && sf > config.maxSilenceFailsafe) {
      shouldSend = true; sf = 0;
    }
    if (shouldSend) sent++; else dropped++;

    const isSpeech = (t >= 9000 && t < 11000) || t >= 17000;
    if (isSpeech) {
      if (shouldSend) speechSent++; else speechDropped++;
    }
  }

  console.log(label + ':');
  console.log('  Total: sent=' + sent + '/' + total + ' (' + Math.round(100 * sent / total) + '%)');
  console.log('  During user speech: sent=' + speechSent + '/' + (speechSent + speechDropped) +
    ' (' + Math.round(100 * speechSent / (speechSent + speechDropped)) + '%)');
}

console.log('=== Gate throughput: Plivo call with inverted energy profile ===');
simulate({ energyOverrideThreshold: 0.85, silenceFramesThreshold: 50, maxSilenceFailsafe: 150 }, 'OLD (0.85)');
simulate({ energyOverrideThreshold: 0, silenceFramesThreshold: 50, maxSilenceFailsafe: 150 }, 'NEW (0 bypass)');

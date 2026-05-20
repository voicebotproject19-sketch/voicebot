

/**
 * HOT PATH CONTRACT
 *
 * This file defines what the system considers "hot path" events.
 *
 * IMPORTANT:
 * - This is a governance contract, not implementation logic.
 * - The validator must consume this file.
 * - If events are renamed during refactor (e.g., RealtimeAdapter),
 *   update ONLY this file — not the validator logic.
 */

module.exports = {
  /**
   * Any .on('<event>') where <event> is listed below
   * is considered hot path and must:
   *  - NOT contain await
   *  - NOT contain Promise chains
   *  - NOT perform IO
   *  - Remain deterministic and low-latency
   */
  HOTPATH_EVENT_NAMES: [
    'message',     // inbound WS audio
    'audio'        // outbound realtime audio
  ],

  /**
   * Optional: define known hot-path files if architecture evolves.
   * Leave empty unless handlers move outside app.js.
   */
  HOTPATH_FILES: [
    'app.js'
  ]
};
/**
 * @license Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @fileoverview Singluar helper to parse a raw trace and extract the most useful data for
 * various tools. This artifact will take a trace and then:
 *
 * 1. Find the TracingStartedInPage and navigationStart events of our intended tab & frame.
 * 2. Find the firstContentfulPaint and marked firstMeaningfulPaint events
 * 3. Isolate only the trace events from the tab's process (including all threads like compositor)
 *      * Sort those trace events in chronological order (as order isn't guaranteed)
 * 4. Return all those items in one handy bundle.
 */

const ComputedArtifact = require('./computed-artifact');
const log = require('lighthouse-logger');
const TracingProcessor = require('../../lib/traces/tracing-processor');
const LHError = require('../../lib/errors');
const Sentry = require('../../lib/sentry');

const ACCEPTABLE_NAVIGATION_URL_REGEX = /^(chrome|https?):/;

class TraceOfTab extends ComputedArtifact {
  get name() {
    return 'TraceOfTab';
  }

  /**
   * Returns true if the event is a navigation start event of a document whose URL seems valid.
   *
   * @param {LH.TraceEvent} event
   */
  static isNavigationStartOfInterest(event) {
    return event.name === 'navigationStart' &&
      (!event.args.data || !event.args.data.documentLoaderURL ||
        ACCEPTABLE_NAVIGATION_URL_REGEX.test(event.args.data.documentLoaderURL));
  }

  /**
   * @param {LH.TraceEvent[]} traceEvents
   * @param {(e: LH.TraceEvent) => boolean} filter
   */
  static filteredStableSort(traceEvents, filter) {
    // create an array of the indices that we want to keep
    const indices = [];
    for (let srcIndex = 0; srcIndex < traceEvents.length; srcIndex++) {
      if (filter(traceEvents[srcIndex])) {
        indices.push(srcIndex);
      }
    }

    // sort by ts, if there's no ts difference sort by index
    indices.sort((indexA, indexB) => {
      const result = traceEvents[indexA].ts - traceEvents[indexB].ts;
      return result ? result : indexA - indexB;
    });

    // create a new array using the target indices from previous sort step
    const sorted = [];
    for (let i = 0; i < indices.length; i++) {
      sorted.push(traceEvents[indices[i]]);
    }

    return sorted;
  }


  /**
   * Finds key trace events, identifies main process/thread, and returns timings of trace events
   * in milliseconds since navigation start in addition to the standard microsecond monotonic timestamps.
   * @param {LH.Trace} trace
   * @return {Promise<LH.Artifacts.TraceOfTab>}
  */
  async compute_(trace) {
    // Parse the trace for our key events and sort them by timestamp. Note: sort
    // *must* be stable to keep events correctly nested.
    const keyEvents = TraceOfTab.filteredStableSort(trace.traceEvents, e => {
      return e.cat.includes('blink.user_timing') ||
          e.cat.includes('loading') ||
          e.cat.includes('devtools.timeline') ||
          e.cat === '__metadata';
    });

    // Find the inspected frame
    const {startedInPageEvt, frameId} = TracingProcessor.findTracingStartedEvt(keyEvents);

    // Filter to just events matching the frame ID for sanity
    const frameEvents = keyEvents.filter(e => e.args.frame === frameId);

    // Our navStart will be the last frame navigation in the trace
    const navigationStart = frameEvents.filter(TraceOfTab.isNavigationStartOfInterest).pop();
    if (!navigationStart) throw new LHError(LHError.errors.NO_NAVSTART);

    // Find our first paint of this frame
    const firstPaint = frameEvents.find(e => e.name === 'firstPaint' && e.ts > navigationStart.ts);

    // FCP will follow at/after the FP. Used in so many places we require it.
    const firstContentfulPaint = frameEvents.find(
      e => e.name === 'firstContentfulPaint' && e.ts > navigationStart.ts
    );
    if (!firstContentfulPaint) throw new LHError(LHError.errors.NO_FCP);

    // fMP will follow at/after the FP
    let firstMeaningfulPaint = frameEvents.find(
      e => e.name === 'firstMeaningfulPaint' && e.ts > navigationStart.ts
    );
    let fmpFellBack = false;

    // If there was no firstMeaningfulPaint event found in the trace, the network idle detection
    // may have not been triggered before Lighthouse finished tracing.
    // In this case, we'll use the last firstMeaningfulPaintCandidate we can find.
    // However, if no candidates were found (a bogus trace, likely), we fail.
    if (!firstMeaningfulPaint) {
      // Track this with Sentry since it's likely a bug we should investigate.
      // @ts-ignore TODO(bckenny): Sentry type checking
      Sentry.captureMessage('No firstMeaningfulPaint found, using fallback', {level: 'warning'});

      const fmpCand = 'firstMeaningfulPaintCandidate';
      fmpFellBack = true;
      log.verbose('trace-of-tab', `No firstMeaningfulPaint found, falling back to last ${fmpCand}`);
      const lastCandidate = frameEvents.filter(e => e.name === fmpCand).pop();
      if (!lastCandidate) {
        log.verbose('trace-of-tab', 'No `firstMeaningfulPaintCandidate` events found in trace');
      }
      firstMeaningfulPaint = lastCandidate;
    }

    const load = frameEvents.find(e => e.name === 'loadEventEnd' && e.ts > navigationStart.ts);
    const domContentLoaded = frameEvents.find(
      e => e.name === 'domContentLoadedEventEnd' && e.ts > navigationStart.ts
    );

    // subset all trace events to just our tab's process (incl threads other than main)
    // stable-sort events to keep them correctly nested.
    const processEvents = TraceOfTab
      .filteredStableSort(trace.traceEvents, e => e.pid === startedInPageEvt.pid);

    const mainThreadEvents = processEvents
      .filter(e => e.tid === startedInPageEvt.tid);

    // traceEnd must exist since at least navigationStart event was verified as existing.
    const traceEnd = trace.traceEvents.reduce((max, evt) => {
      return max.ts > evt.ts ? max : evt;
    });
    const fakeEndOfTraceEvt = {ts: traceEnd.ts + (traceEnd.dur || 0)};

    /** @param {{ts: number}=} event */
    const getTimestamp = (event) => event && event.ts;
    /** @type {LH.Artifacts.TraceTimes} */
    const timestamps = {
      navigationStart: navigationStart.ts,
      firstPaint: getTimestamp(firstPaint),
      firstContentfulPaint: firstContentfulPaint.ts,
      firstMeaningfulPaint: getTimestamp(firstMeaningfulPaint),
      traceEnd: fakeEndOfTraceEvt.ts,
      load: getTimestamp(load),
      domContentLoaded: getTimestamp(domContentLoaded),
    };


    /** @param {number} ts */
    const getTiming = (ts) => (ts - navigationStart.ts) / 1000;
    /** @param {number=} ts */
    const maybeGetTiming = (ts) => ts === undefined ? undefined : getTiming(ts);
    /** @type {LH.Artifacts.TraceTimes} */
    const timings = {
      navigationStart: 0,
      firstPaint: maybeGetTiming(timestamps.firstPaint),
      firstContentfulPaint: getTiming(timestamps.firstContentfulPaint),
      firstMeaningfulPaint: maybeGetTiming(timestamps.firstMeaningfulPaint),
      traceEnd: getTiming(timestamps.traceEnd),
      load: maybeGetTiming(timestamps.load),
      domContentLoaded: maybeGetTiming(timestamps.domContentLoaded),
    };

    return {
      timings,
      timestamps,
      processEvents,
      mainThreadEvents,
      startedInPageEvt,
      navigationStartEvt: navigationStart,
      firstPaintEvt: firstPaint,
      firstContentfulPaintEvt: firstContentfulPaint,
      firstMeaningfulPaintEvt: firstMeaningfulPaint,
      loadEvt: load,
      domContentLoadedEvt: domContentLoaded,
      fmpFellBack,
    };
  }
}

module.exports = TraceOfTab;

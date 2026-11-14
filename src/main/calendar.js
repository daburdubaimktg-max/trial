// Read-only calendar access through private iCal (.ics) links.
// Google Calendar, Outlook and Apple Calendar can all publish one, so this
// works without an OAuth app.

const ical = require("node-ical");

const FETCH_TIMEOUT_MS = 15000;

function summaryText(value) {
  if (value && typeof value === "object" && "val" in value) return String(value.val);
  return value ? String(value) : "(no title)";
}

/** Expand every event in an ICS document that falls inside [from, to]. */
function eventsFromIcs(icsText, from, to) {
  const parsed = ical.sync.parseICS(icsText);
  const events = [];
  for (const item of Object.values(parsed)) {
    if (item.type !== "VEVENT" || !item.start) continue;
    if (item.status === "CANCELLED") continue;
    for (const inst of ical.expandRecurringEvent(item, { from, to })) {
      events.push({
        title: summaryText(inst.summary),
        start: inst.start.toISOString(),
        end: inst.end ? inst.end.toISOString() : null,
        allDay: Boolean(inst.isFullDay),
        location: item.location ? summaryText(item.location) : "",
      });
    }
  }
  return events.sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Fetch all configured calendars and return events in the range.
 * A calendar that fails to load is reported in `errors` rather than hiding
 * the others.
 */
async function getEvents(urls, from, to, fetchImpl = fetch) {
  const events = [];
  const errors = [];
  await Promise.all(
    urls.map(async (rawUrl, index) => {
      const label = `calendar ${index + 1}`;
      try {
        // Calendar apps hand out webcal:// links; they are plain HTTPS.
        const url = rawUrl.replace(/^webcal:\/\//i, "https://");
        if (!/^https:\/\//i.test(url)) throw new Error("link must start with https:// or webcal://");
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`server answered ${res.status}`);
        events.push(...eventsFromIcs(await res.text(), from, to));
      } catch (err) {
        errors.push(`${label}: ${err.message}`);
      }
    }),
  );
  events.sort((a, b) => a.start.localeCompare(b.start));
  return { events, errors };
}

module.exports = { getEvents, eventsFromIcs };

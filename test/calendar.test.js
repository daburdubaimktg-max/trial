const test = require("node:test");
const assert = require("node:assert/strict");
const { eventsFromIcs, getEvents } = require("../src/main/calendar");

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:1",
  "DTSTART;TZID=Asia/Dubai:20261102T090000",
  "DTEND;TZID=Asia/Dubai:20261102T093000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
  "EXDATE;TZID=Asia/Dubai:20261111T090000",
  "SUMMARY:Standup",
  "LOCATION:Room 1",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:2",
  "DTSTART;VALUE=DATE:20261110",
  "DTEND;VALUE=DATE:20261111",
  "SUMMARY:Planning day",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:3",
  "DTSTART:20261110T120000Z",
  "DTEND:20261110T130000Z",
  "SUMMARY:Cancelled lunch",
  "STATUS:CANCELLED",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:4",
  "DTSTART:20261201T120000Z",
  "DTEND:20261201T130000Z",
  "SUMMARY:Out of range",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const from = new Date("2026-11-08T20:00:00Z"); // Mon 9 Nov 00:00 Dubai
const to = new Date("2026-11-15T20:00:00Z");

test("expands recurring events, honours exclusions, skips cancelled and out-of-range", () => {
  const events = eventsFromIcs(ICS, from, to);
  const standups = events.filter((e) => e.title === "Standup");
  // Mon 9 Nov only: Wed 11 Nov is excluded by EXDATE.
  assert.deepEqual(standups.map((e) => e.start), ["2026-11-09T05:00:00.000Z"]);
  assert.equal(standups[0].end, "2026-11-09T05:30:00.000Z");
  assert.equal(standups[0].location, "Room 1");

  const allDay = events.find((e) => e.title === "Planning day");
  assert.equal(allDay.allDay, true);
  assert.equal(events.some((e) => e.title === "Cancelled lunch"), false);
  assert.equal(events.some((e) => e.title === "Out of range"), false);
});

test("getEvents accepts webcal links and reports a failing calendar without losing the others", async () => {
  const seen = [];
  const fakeFetch = async (url) => {
    seen.push(url);
    if (url.includes("broken")) return { ok: false, status: 404 };
    return { ok: true, text: async () => ICS };
  };
  const { events, errors } = await getEvents(
    ["webcal://cal.example/a.ics", "https://cal.example/broken.ics", "ftp://nope"],
    from,
    to,
    fakeFetch,
  );
  assert.deepEqual(seen.sort(), ["https://cal.example/a.ics", "https://cal.example/broken.ics"]);
  assert.ok(events.length >= 2);
  assert.equal(errors.length, 2);
  assert.match(errors.join(" "), /404/);
  assert.match(errors.join(" "), /must start with https/);
});

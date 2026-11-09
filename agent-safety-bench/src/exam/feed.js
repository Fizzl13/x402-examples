// What a sitting's live view shows: an ordered list of public events (start, every request, every answer, the finish)
// and whoever is listening (the server-sent event streams of /live pages). Nothing in it names the exam id.

export function createFeed({ max = 500 } = {}) {
  const events = [];
  const listeners = new Set();
  let n = 0;
  return {
    events,
    push(ev) {
      const e = { n: ++n, ...ev };
      // Requests beyond `max` are still streamed, not kept; the start, answers and the finish are always kept.
      if (events.length < max || e.type !== "request") events.push(e);
      for (const fn of listeners) {
        try {
          fn(e);
        } catch {
          listeners.delete(fn);
        }
      }
      return e;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get listeners() {
      return listeners.size;
    },
  };
}

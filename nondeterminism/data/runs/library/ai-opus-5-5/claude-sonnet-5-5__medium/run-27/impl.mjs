const DAY = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1 || y > 9999) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(dt.getTime() / DAY);
}

function fmt(n) {
  const dt = new Date(n * DAY);
  const p = (v, l) => String(v).padStart(l, '0');
  return p(dt.getUTCFullYear(), 4) + '-' + p(dt.getUTCMonth() + 1, 2) + '-' + p(dt.getUTCDate(), 2);
}

const validId = (v) => typeof v === 'string' && v.length > 0;
const fail = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let now = null;
  let seq = 0;

  function expire(day) {
    for (const b of books.values()) {
      while (b.ready && day > b.readyUntil) {
        b.queue.shift();
        if (b.queue.length > 0) {
          b.readyUntil = b.readyUntil + 8;
        } else {
          b.ready = false;
          b.readyUntil = null;
        }
      }
    }
  }

  // returns day number, or null on failure (clock untouched)
  function begin(args) {
    if (args === null || typeof args !== 'object') return null;
    const day = parseDate(args.date);
    if (day === null) return null;
    if (now !== null && day < now) return null;
    now = day;
    expire(day);
    return day;
  }

  function setAside(b, day) {
    if (b.queue.length === 0) {
      b.ready = false;
      b.readyUntil = null;
    } else {
      b.ready = true;
      b.readyUntil = day + 7;
    }
  }

  return {
    addBook(a) {
      if (a === null || typeof a !== 'object' || !validId(a.bookId)) return fail('invalid');
      if (books.has(a.bookId)) return fail('exists');
      books.set(a.bookId, { loan: null, queue: [], ready: false, readyUntil: null });
      return { ok: true };
    },
    addMember(a) {
      if (a === null || typeof a !== 'object' || !validId(a.memberId)) return fail('invalid');
      if (members.has(a.memberId)) return fail('exists');
      members.set(a.memberId, { loans: [], owed: 0 });
      return { ok: true };
    },
    borrow(a) {
      const day = begin(a);
      if (day === null) return fail('invalid');
      if (!validId(a.memberId) || !validId(a.bookId)) return fail('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (b.ready && b.queue[0].memberId !== a.memberId) return fail('set aside');
      if (m.loans.length >= 5) return fail('limit');
      if (m.owed >= 1000) return fail('owed');
      for (const id of m.loans) if (books.get(id).loan.dueDate < day) return fail('overdue');
      if (b.ready) {
        b.queue.shift();
        b.ready = false;
        b.readyUntil = null;
      }
      const dueDate = day + 21;
      b.loan = { memberId: a.memberId, dueDate, renewals: 0 };
      m.loans.push(a.bookId);
      return { ok: true, dueDate: fmt(dueDate) };
    },
    returnBook(a) {
      const day = begin(a);
      if (day === null) return fail('invalid');
      if (!validId(a.memberId) || !validId(a.bookId)) return fail('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== a.memberId) return fail('not loaned');
      const late = Math.max(0, day - b.loan.dueDate);
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      b.loan = null;
      m.loans.splice(m.loans.indexOf(a.bookId), 1);
      setAside(b, day);
      return { ok: true, fine };
    },
    renew(a) {
      const day = begin(a);
      if (day === null) return fail('invalid');
      if (!validId(a.memberId) || !validId(a.bookId)) return fail('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== a.memberId) return fail('not loaned');
      if (b.loan.renewals >= 2) return fail('max renewals');
      if (day > b.loan.dueDate) return fail('overdue');
      if (b.queue.length > 0) return fail('holds');
      b.loan.dueDate = day + 21;
      b.loan.renewals++;
      return { ok: true, dueDate: fmt(b.loan.dueDate) };
    },
    placeHold(a) {
      const day = begin(a);
      if (day === null) return fail('invalid');
      if (!validId(a.memberId) || !validId(a.bookId)) return fail('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && !b.ready) return fail('available');
      if (b.loan && b.loan.memberId === a.memberId) return fail('own loan');
      if (b.queue.some((h) => h.memberId === a.memberId)) return fail('dup');
      let count = 0;
      for (const bb of books.values()) if (bb.queue.some((h) => h.memberId === a.memberId)) count++;
      if (count >= 5) return fail('hold limit');
      b.queue.push({ memberId: a.memberId, seq: seq++ });
      return { ok: true, position: b.queue.length };
    },
    payFine(a) {
      const day = begin(a);
      if (day === null) return fail('invalid');
      if (!validId(a.memberId)) return fail('invalid');
      if (!Number.isSafeInteger(a.amount) || a.amount <= 0) return fail('amount');
      const m = members.get(a.memberId);
      if (!m) return fail('unknown');
      if (a.amount > m.owed) return fail('overpay');
      m.owed -= a.amount;
      return { ok: true, owed: m.owed };
    },
    getMember(a) {
      const day = begin(a);
      if (day === null) return fail('invalid');
      if (!validId(a.memberId)) return fail('invalid');
      const m = members.get(a.memberId);
      if (!m) return fail('unknown');
      const loans = m.loans.map((id) => ({ bookId: id, dueDate: fmt(books.get(id).loan.dueDate) }));
      const hs = [];
      for (const [id, b] of books) {
        const i = b.queue.findIndex((h) => h.memberId === a.memberId);
        if (i >= 0) {
          hs.push({
            seq: b.queue[i].seq,
            h: {
              bookId: id,
              position: i + 1,
              readyUntil: i === 0 && b.ready ? fmt(b.readyUntil) : null,
            },
          });
        }
      }
      hs.sort((x, y) => x.seq - y.seq);
      return { ok: true, loans, owed: m.owed, holds: hs.map((x) => x.h) };
    },
  };
}

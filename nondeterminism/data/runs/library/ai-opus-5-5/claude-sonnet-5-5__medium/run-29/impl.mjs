const isId = (v) => typeof v === 'string' && v.length > 0;
const DAY = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(dt.getTime() / DAY);
}

function fmt(n) {
  return new Date(n * DAY).toISOString().slice(0, 10);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;
  let seq = 0;
  const FAIL = (reason) => ({ ok: false, reason });

  function expire(day) {
    for (const b of books.values()) {
      while (b.state === 'aside' && day > b.readyUntil) {
        b.queue.shift();
        if (b.queue.length > 0) {
          b.readyUntil = b.readyUntil + 1 + 7;
        } else {
          b.state = 'available';
          b.readyUntil = null;
        }
      }
    }
  }

  // Returns day number or null; handles clock and expiry.
  function begin(args) {
    if (args === null || typeof args !== 'object') return null;
    const day = parseDate(args.date);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    expire(day);
    return day;
  }

  function activeHolds(memberId) {
    let n = 0;
    for (const b of books.values()) {
      for (const h of b.queue) if (h.memberId === memberId) n++;
    }
    return n;
  }

  return {
    addBook(args) {
      if (args === null || typeof args !== 'object') return FAIL('invalid');
      const { bookId } = args;
      if (!isId(bookId) || books.has(bookId)) return FAIL('invalid');
      books.set(bookId, { state: 'available', borrower: null, dueDate: 0, renewals: 0, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember(args) {
      if (args === null || typeof args !== 'object') return FAIL('invalid');
      const { memberId } = args;
      if (!isId(memberId) || members.has(memberId)) return FAIL('invalid');
      members.set(memberId, { loans: [], owed: 0 });
      return { ok: true };
    },

    borrow(args) {
      const day = begin(args);
      if (day === null) return FAIL('invalid');
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return FAIL('invalid');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.state === 'loan') return FAIL('on loan');
      if (b.state === 'aside' && b.queue[0].memberId !== memberId) return FAIL('set aside');
      if (m.loans.length >= 5) return FAIL('limit');
      for (const id of m.loans) if (books.get(id).dueDate < day) return FAIL('overdue');
      if (m.owed >= 1000) return FAIL('owed');
      if (b.state === 'aside') {
        b.queue.shift();
        b.readyUntil = null;
      }
      b.state = 'loan';
      b.borrower = memberId;
      b.dueDate = day + 21;
      b.renewals = 0;
      m.loans.push(bookId);
      return { ok: true, dueDate: fmt(b.dueDate) };
    },

    returnBook(args) {
      const day = begin(args);
      if (day === null) return FAIL('invalid');
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return FAIL('invalid');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.state !== 'loan' || b.borrower !== memberId) return FAIL('not loaned');
      const late = Math.max(0, day - b.dueDate);
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      m.loans = m.loans.filter((x) => x !== bookId);
      b.borrower = null;
      if (b.queue.length === 0) {
        b.state = 'available';
        b.readyUntil = null;
      } else {
        b.state = 'aside';
        b.readyUntil = day + 7;
      }
      return { ok: true, fine };
    },

    renew(args) {
      const day = begin(args);
      if (day === null) return FAIL('invalid');
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return FAIL('invalid');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.state !== 'loan' || b.borrower !== memberId) return FAIL('not loaned');
      if (b.renewals >= 2) return FAIL('max renewals');
      if (day > b.dueDate) return FAIL('overdue');
      if (b.queue.length > 0) return FAIL('holds');
      b.dueDate = day + 21;
      b.renewals++;
      return { ok: true, dueDate: fmt(b.dueDate) };
    },

    placeHold(args) {
      const day = begin(args);
      if (day === null) return FAIL('invalid');
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return FAIL('invalid');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.state === 'available') return FAIL('available');
      if (b.state === 'loan' && b.borrower === memberId) return FAIL('own loan');
      if (b.queue.some((h) => h.memberId === memberId)) return FAIL('duplicate');
      if (activeHolds(memberId) >= 5) return FAIL('hold limit');
      b.queue.push({ memberId, seq: seq++ });
      return { ok: true, position: b.queue.length };
    },

    payFine(args) {
      const day = begin(args);
      if (day === null) return FAIL('invalid');
      const { memberId, amount } = args;
      if (!isId(memberId)) return FAIL('invalid');
      if (!Number.isSafeInteger(amount) || amount <= 0) return FAIL('amount');
      const m = members.get(memberId);
      if (!m) return FAIL('unknown');
      if (amount > m.owed) return FAIL('overpay');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      const day = begin(args);
      if (day === null) return FAIL('invalid');
      const { memberId } = args;
      if (!isId(memberId)) return FAIL('invalid');
      const m = members.get(memberId);
      if (!m) return FAIL('unknown');
      const loans = m.loans.map((id) => ({ bookId: id, dueDate: fmt(books.get(id).dueDate) }));
      const hs = [];
      for (const [id, b] of books) {
        b.queue.forEach((h, i) => {
          if (h.memberId === memberId) {
            hs.push({
              seq: h.seq,
              bookId: id,
              position: i + 1,
              readyUntil: b.state === 'aside' && i === 0 ? fmt(b.readyUntil) : null,
            });
          }
        });
      }
      hs.sort((a, b) => a.seq - b.seq);
      const holds = hs.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil }));
      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}

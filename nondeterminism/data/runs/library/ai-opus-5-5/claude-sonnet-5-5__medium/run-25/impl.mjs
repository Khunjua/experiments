const isId = (v) => typeof v === 'string' && v.length > 0;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.getTime();
}
const DAY = 86400000;
function fmt(ms) {
  const dt = new Date(ms);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function addDays(s, n) {
  return fmt(parseDate(s) + n * DAY);
}
function diffDays(a, b) {
  return Math.round((parseDate(a) - parseDate(b)) / DAY);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;
  const fail = (reason) => ({ ok: false, reason });

  function expire(date) {
    for (const [bookId, b] of books) {
      while (b.state === 'aside' && date > b.readyUntil) {
        const mid = b.queue.shift();
        const m = members.get(mid);
        m.holds.splice(m.holds.indexOf(bookId), 1);
        if (b.queue.length) {
          b.readyUntil = addDays(b.readyUntil, 8);
        } else {
          b.state = 'avail';
          b.readyUntil = null;
        }
      }
    }
  }

  // returns null on failure, else the args object
  function begin(a) {
    if (a === null || typeof a !== 'object') return null;
    if (parseDate(a.date) === null) return null;
    if (current !== null && a.date < current) return null;
    current = a.date;
    expire(a.date);
    return a;
  }

  return {
    addBook(a) {
      if (a === null || typeof a !== 'object' || !isId(a.bookId)) return fail('invalid');
      if (books.has(a.bookId)) return fail('exists');
      books.set(a.bookId, { state: 'avail', loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember(a) {
      if (a === null || typeof a !== 'object' || !isId(a.memberId)) return fail('invalid');
      if (members.has(a.memberId)) return fail('exists');
      members.set(a.memberId, { loans: [], owed: 0, holds: [] });
      return { ok: true };
    },
    borrow(a) {
      if (!begin(a)) return fail('invalid');
      if (!isId(a.memberId) || !isId(a.bookId)) return fail('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return fail('unknown');
      if (b.state === 'loan') return fail('on loan');
      if (b.state === 'aside' && b.queue[0] !== a.memberId) return fail('set aside');
      if (m.loans.length >= 5) return fail('limit');
      for (const id of m.loans) if (books.get(id).loan.dueDate < a.date) return fail('overdue');
      if (m.owed >= 1000) return fail('owed');
      if (b.state === 'aside') {
        b.queue.shift();
        m.holds.splice(m.holds.indexOf(a.bookId), 1);
        b.readyUntil = null;
      }
      const dueDate = addDays(a.date, 21);
      b.state = 'loan';
      b.loan = { memberId: a.memberId, dueDate, renewals: 0 };
      m.loans.push(a.bookId);
      return { ok: true, dueDate };
    },
    returnBook(a) {
      if (!begin(a)) return fail('invalid');
      if (!isId(a.memberId) || !isId(a.bookId)) return fail('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return fail('unknown');
      if (b.state !== 'loan' || b.loan.memberId !== a.memberId) return fail('not borrowed');
      const late = Math.max(0, diffDays(a.date, b.loan.dueDate));
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      m.loans.splice(m.loans.indexOf(a.bookId), 1);
      b.loan = null;
      if (b.queue.length) {
        b.state = 'aside';
        b.readyUntil = addDays(a.date, 7);
      } else {
        b.state = 'avail';
        b.readyUntil = null;
      }
      return { ok: true, fine };
    },
    renew(a) {
      if (!begin(a)) return fail('invalid');
      if (!isId(a.memberId) || !isId(a.bookId)) return fail('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return fail('unknown');
      if (b.state !== 'loan' || b.loan.memberId !== a.memberId) return fail('not borrowed');
      if (b.loan.renewals >= 2) return fail('max renewals');
      if (a.date > b.loan.dueDate) return fail('overdue');
      if (b.queue.length) return fail('holds');
      b.loan.dueDate = addDays(a.date, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold(a) {
      if (!begin(a)) return fail('invalid');
      if (!isId(a.memberId) || !isId(a.bookId)) return fail('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return fail('unknown');
      if (b.state === 'avail') return fail('available');
      if (b.state === 'loan' && b.loan.memberId === a.memberId) return fail('own loan');
      if (b.queue.includes(a.memberId)) return fail('duplicate');
      if (m.holds.length >= 5) return fail('limit');
      b.queue.push(a.memberId);
      m.holds.push(a.bookId);
      return { ok: true, position: b.queue.length };
    },
    payFine(a) {
      if (!begin(a)) return fail('invalid');
      if (!isId(a.memberId)) return fail('invalid');
      if (!Number.isSafeInteger(a.amount) || a.amount <= 0) return fail('amount');
      const m = members.get(a.memberId);
      if (!m) return fail('unknown');
      if (a.amount > m.owed) return fail('overpay');
      m.owed -= a.amount;
      return { ok: true, owed: m.owed };
    },
    getMember(a) {
      if (!begin(a)) return fail('invalid');
      if (!isId(a.memberId)) return fail('invalid');
      const m = members.get(a.memberId);
      if (!m) return fail('unknown');
      return {
        ok: true,
        loans: m.loans.map((id) => ({ bookId: id, dueDate: books.get(id).loan.dueDate })),
        owed: m.owed,
        holds: m.holds.map((id) => {
          const b = books.get(id);
          const idx = b.queue.indexOf(a.memberId);
          return {
            bookId: id,
            position: idx + 1,
            readyUntil: b.state === 'aside' && idx === 0 ? b.readyUntil : null,
          };
        }),
      };
    },
  };
}

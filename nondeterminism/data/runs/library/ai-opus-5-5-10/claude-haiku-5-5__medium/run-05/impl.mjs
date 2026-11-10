const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_LATE_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE = 1000;
const DEBT_LIMIT = 1000;
const PICKUP_DAYS = 7;

// Returns the day number (days since 1970-01-01, UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return Math.round(dt.getTime() / DAY_MS);
}

function formatDate(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function asObject(x) {
  return x !== null && typeof x === 'object' ? x : null;
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  // bookId -> { id, state: 'available'|'loan'|'setAside', loanMember, readyUntil, queue: [{ memberId, seq }] }
  const books = new Map();
  // memberId -> { id, owed, loans: [{ bookId, dueDate, renewals }] }
  const members = new Map();
  let lastDate = null;
  let seq = 0;

  function expire(D) {
    for (const book of books.values()) {
      while (book.state === 'setAside' && D > book.readyUntil) {
        book.queue.shift();
        const S = book.readyUntil + 1;
        if (book.queue.length > 0) {
          book.readyUntil = S + PICKUP_DAYS;
        } else {
          book.state = 'available';
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates the date, enforces the clock and runs time processing.
  // Returns the day number, or null if the call must fail on the date.
  function admit(dateStr) {
    const D = parseDate(dateStr);
    if (D === null) return null;
    if (lastDate !== null && D < lastDate) return null;
    lastDate = D;
    expire(D);
    return D;
  }

  return {
    addBook(args) {
      const a = asObject(args);
      if (!a || !isId(a.bookId)) return fail('invalid bookId');
      if (books.has(a.bookId)) return fail('book already exists');
      books.set(a.bookId, {
        id: a.bookId,
        state: 'available',
        loanMember: null,
        readyUntil: null,
        queue: [],
      });
      return { ok: true };
    },

    addMember(args) {
      const a = asObject(args);
      if (!a || !isId(a.memberId)) return fail('invalid memberId');
      if (members.has(a.memberId)) return fail('member already exists');
      members.set(a.memberId, { id: a.memberId, owed: 0, loans: [] });
      return { ok: true };
    },

    borrow(args) {
      const a = asObject(args);
      if (!a || !isId(a.memberId) || !isId(a.bookId)) return fail('invalid arguments');
      const D = admit(a.date);
      if (D === null) return fail('invalid or out-of-order date');
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return fail('unknown member or book');
      if (b.state === 'loan') return fail('book on loan');
      if (b.state === 'setAside' && b.queue[0].memberId !== m.id) {
        return fail('book set aside for another member');
      }
      if (b.state === 'available' && b.queue.length > 0) return fail('book has waiting members');
      if (m.owed >= DEBT_LIMIT) return fail('member owes too much');
      if (m.loans.some((l) => D > l.dueDate)) return fail('member has overdue loan');
      if (m.loans.length >= MAX_LOANS) return fail('loan limit reached');

      const dueDate = D + LOAN_DAYS;
      m.loans.push({ bookId: b.id, dueDate, renewals: 0 });
      if (b.state === 'setAside') {
        b.queue.shift();
      }
      b.state = 'loan';
      b.loanMember = m.id;
      b.readyUntil = null;
      return { ok: true, dueDate: formatDate(dueDate) };
    },

    returnBook(args) {
      const a = asObject(args);
      if (!a || !isId(a.memberId) || !isId(a.bookId)) return fail('invalid arguments');
      const D = admit(a.date);
      if (D === null) return fail('invalid or out-of-order date');
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return fail('unknown member or book');
      const idx = m.loans.findIndex((l) => l.bookId === b.id);
      if (idx < 0 || b.state !== 'loan' || b.loanMember !== m.id) {
        return fail('book not on loan to member');
      }
      const loan = m.loans[idx];
      const late = Math.max(0, D - loan.dueDate);
      const fine = Math.min(MAX_FINE, FINE_PER_LATE_DAY * Math.max(0, late - GRACE_DAYS));
      m.owed += fine;
      m.loans.splice(idx, 1);
      b.loanMember = null;
      if (b.queue.length > 0) {
        b.state = 'setAside';
        b.readyUntil = D + PICKUP_DAYS;
      } else {
        b.state = 'available';
        b.readyUntil = null;
      }
      return { ok: true, fine };
    },

    renew(args) {
      const a = asObject(args);
      if (!a || !isId(a.memberId) || !isId(a.bookId)) return fail('invalid arguments');
      const D = admit(a.date);
      if (D === null) return fail('invalid or out-of-order date');
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return fail('unknown member or book');
      const loan = m.loans.find((l) => l.bookId === b.id);
      if (!loan) return fail('book not on loan to member');
      if (D > loan.dueDate) return fail('loan is overdue');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (b.queue.length > 0) return fail('book has waiting members');
      if (m.owed >= DEBT_LIMIT) return fail('member owes too much');
      loan.dueDate += LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDate(loan.dueDate) };
    },

    placeHold(args) {
      const a = asObject(args);
      if (!a || !isId(a.memberId) || !isId(a.bookId)) return fail('invalid arguments');
      const D = admit(a.date);
      if (D === null) return fail('invalid or out-of-order date');
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return fail('unknown member or book');
      if (b.state === 'available') return fail('book is available; borrow it instead');
      if (b.state === 'loan' && b.loanMember === m.id) return fail('member has this book on loan');
      if (b.queue.some((e) => e.memberId === m.id)) return fail('member already has a hold');
      seq += 1;
      b.queue.push({ memberId: m.id, seq });
      return { ok: true, position: b.queue.length };
    },

    payFine(args) {
      const a = asObject(args);
      if (!a || !isId(a.memberId) || !Number.isInteger(a.amount)) return fail('invalid arguments');
      const D = admit(a.date);
      if (D === null) return fail('invalid or out-of-order date');
      const m = members.get(a.memberId);
      if (!m) return fail('unknown member');
      if (a.amount < 1) return fail('amount too small');
      if (a.amount > m.owed) return fail('amount exceeds debt');
      m.owed -= a.amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      const a = asObject(args);
      if (!a || !isId(a.memberId)) return fail('invalid memberId');
      const D = admit(a.date);
      if (D === null) return fail('invalid or out-of-order date');
      const m = members.get(a.memberId);
      if (!m) return fail('unknown member');

      const loans = m.loans.map((l) => ({
        bookId: l.bookId,
        dueDate: formatDate(l.dueDate),
      }));

      const found = [];
      for (const b of books.values()) {
        const idx = b.queue.findIndex((e) => e.memberId === m.id);
        if (idx >= 0) {
          const setAsideForMe = idx === 0 && b.state === 'setAside';
          found.push({
            seq: b.queue[idx].seq,
            bookId: b.id,
            position: idx + 1,
            readyUntil: setAsideForMe ? formatDate(b.readyUntil) : null,
          });
        }
      }
      found.sort((x, y) => x.seq - y.seq);
      const holds = found.map((h) => ({
        bookId: h.bookId,
        position: h.position,
        readyUntil: h.readyUntil,
      }));

      return { loans, owed: m.owed, holds };
    },
  };
}

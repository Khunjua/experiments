const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const GRACE_DAYS = 0;
const BORROW_BLOCK_OWED = 1000;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// Returns an integer day number (days since 1970-01-01 UTC), or null if invalid.
function parseDate(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  return dt.getTime() / MS_PER_DAY;
}

function fmt(n) {
  const dt = new Date(n * MS_PER_DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function args(a) {
  return a && typeof a === 'object' ? a : {};
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let latest = null;

  function expire(D) {
    for (const book of books.values()) {
      while (book.status === 'set' && book.readyUntil < D) {
        const holder = members.get(book.holdMember);
        const idx = holder.holds.indexOf(book.id);
        if (idx >= 0) holder.holds.splice(idx, 1);
        const start = book.readyUntil + 1;
        if (book.queue.length > 0) {
          book.holdMember = book.queue.shift();
          book.readyUntil = start + PICKUP_DAYS;
        } else {
          book.status = 'shelf';
          book.holdMember = null;
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates a dated call's date, updates latest seen and runs expiry.
  // Returns the day number, or null if the call must be rejected.
  function accept(v) {
    const d = parseDate(v);
    if (d === null) return null;
    if (latest !== null && d < latest) return null;
    latest = d;
    expire(d);
    return d;
  }

  function removeHold(member, bookId) {
    const idx = member.holds.indexOf(bookId);
    if (idx >= 0) member.holds.splice(idx, 1);
  }

  return {
    addBook(arg) {
      const { bookId } = args(arg);
      if (!isId(bookId) || books.has(bookId)) return { ok: false };
      books.set(bookId, {
        id: bookId,
        status: 'shelf',
        loanMember: null,
        holdMember: null,
        readyUntil: null,
        queue: [],
      });
      return { ok: true };
    },

    addMember(arg) {
      const { memberId } = args(arg);
      if (!isId(memberId) || members.has(memberId)) return { ok: false };
      members.set(memberId, {
        owed: 0,
        loans: new Map(), // bookId -> { dueDay, renewals }, in creation order
        holds: [],        // bookIds in placement order (waiting or set aside)
      });
      return { ok: true };
    },

    borrow(arg) {
      const { memberId, bookId, date } = args(arg);
      const D = accept(date);
      if (D === null) return { ok: false };
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.status === 'loan') return { ok: false };
      if (b.status === 'set' && b.holdMember !== memberId) return { ok: false };
      if (b.status === 'shelf' && b.queue.length > 0) return { ok: false };
      if (m.loans.size >= MAX_LOANS) return { ok: false };
      if (m.owed >= BORROW_BLOCK_OWED) return { ok: false };

      if (b.status === 'set') {
        removeHold(m, bookId);
        b.holdMember = null;
        b.readyUntil = null;
      }
      b.status = 'loan';
      b.loanMember = memberId;
      const dueDay = D + LOAN_DAYS;
      m.loans.set(bookId, { dueDay, renewals: 0 });
      return { ok: true, dueDate: fmt(dueDay) };
    },

    returnBook(arg) {
      const { memberId, bookId, date } = args(arg);
      const D = accept(date);
      if (D === null) return { ok: false };
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.status !== 'loan' || b.loanMember !== memberId) return { ok: false };
      const loan = m.loans.get(bookId);
      if (!loan) return { ok: false };

      const daysLate = Math.max(0, D - GRACE_DAYS - loan.dueDay);
      const fine = Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      m.owed += fine;
      m.loans.delete(bookId);

      b.loanMember = null;
      if (b.queue.length > 0) {
        b.status = 'set';
        b.holdMember = b.queue.shift();
        b.readyUntil = D + PICKUP_DAYS;
      } else {
        b.status = 'shelf';
      }
      return { ok: true, fine };
    },

    renew(arg) {
      const { memberId, bookId, date } = args(arg);
      const D = accept(date);
      if (D === null) return { ok: false };
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.status !== 'loan' || b.loanMember !== memberId) return { ok: false };
      const loan = m.loans.get(bookId);
      if (!loan) return { ok: false };
      if (loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (D > loan.dueDay) return { ok: false };
      if (b.queue.length > 0) return { ok: false };

      loan.dueDay = D + LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: fmt(loan.dueDay) };
    },

    placeHold(arg) {
      const { memberId, bookId, date } = args(arg);
      const D = accept(date);
      if (D === null) return { ok: false };
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.status === 'shelf') return { ok: false };
      if (b.status === 'loan' && b.loanMember === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };
      if (b.status === 'set' && b.holdMember === memberId) return { ok: false };
      if (m.holds.length >= MAX_HOLDS) return { ok: false };

      b.queue.push(memberId);
      m.holds.push(bookId);
      const position = b.queue.length + (b.status === 'set' ? 1 : 0);
      return { ok: true, position };
    },

    payFine(arg) {
      const { memberId, amount, date } = args(arg);
      const D = accept(date);
      if (D === null) return { ok: false };
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0) return { ok: false };
      if (amount > m.owed) return { ok: false };

      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember(arg) {
      const { memberId, date } = args(arg);
      const D = accept(date);
      if (D === null) return { ok: false };
      const m = members.get(memberId);
      if (!m) return { ok: false };

      const loans = [];
      for (const [bookId, loan] of m.loans) {
        loans.push({ bookId, dueDate: fmt(loan.dueDay) });
      }

      const holds = m.holds.map((bookId) => {
        const b = books.get(bookId);
        if (b.status === 'set' && b.holdMember === memberId) {
          return { bookId, position: 1, readyUntil: fmt(b.readyUntil) };
        }
        const idx = b.queue.indexOf(memberId);
        const position = idx + 1 + (b.status === 'set' ? 1 : 0);
        return { bookId, position, readyUntil: null };
      });

      return { loans, owed: m.owed, holds };
    },
  };
}

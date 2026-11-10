const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 1000;
const BLOCK_THRESHOLD = 500;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return Math.round(t.getTime() / MS_PER_DAY);
}

function formatDay(n) {
  const t = new Date(n * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function validId(v) {
  return typeof v === 'string' && v.length > 0;
}

function validAmount(v) {
  return Number.isInteger(v) && v > 0;
}

function asObj(x) {
  return x !== null && typeof x === 'object' ? x : {};
}

function newBook() {
  return {
    status: 'available', // 'available' | 'loan' | 'aside'
    holdLine: [],
    loanMember: null,
    dueDay: null,
    renewals: 0,
    readyUntilDay: null,
  };
}

export function createLibrary() {
  const books = new Map();   // bookId -> book record
  const members = new Map(); // memberId -> { owed, loans: Set<bookId>, holds: Set<bookId> }

  function expire(day) {
    for (const [bookId, book] of books) {
      while (book.status === 'aside' && day > book.readyUntilDay) {
        const gone = book.holdLine.shift();
        const m = members.get(gone);
        if (m) m.holds.delete(bookId);
        if (book.holdLine.length > 0) {
          book.readyUntilDay = book.readyUntilDay + 1 + PICKUP_DAYS;
        } else {
          book.status = 'available';
          book.readyUntilDay = null;
        }
      }
    }
  }

  // Validates the date and runs expiry. Returns null if the date is invalid.
  function prepare(input) {
    const a = asObj(input);
    const day = parseDay(a.date);
    if (day === null) return null;
    expire(day);
    return { a, day };
  }

  return {
    addBook(input) {
      try {
        const { bookId } = asObj(input);
        if (!validId(bookId) || books.has(bookId)) return { ok: false };
        books.set(bookId, newBook());
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },

    addMember(input) {
      try {
        const { memberId } = asObj(input);
        if (!validId(memberId) || members.has(memberId)) return { ok: false };
        members.set(memberId, { owed: 0, loans: new Set(), holds: new Set() });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },

    borrow(input) {
      try {
        const p = prepare(input);
        if (!p) return { ok: false };
        const { memberId, bookId } = p.a;
        if (!validId(memberId) || !validId(bookId)) return { ok: false };
        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return { ok: false };
        if (book.status === 'loan') return { ok: false };
        if (book.status === 'aside' && book.holdLine[0] !== memberId) return { ok: false };
        for (const id of member.loans) {
          if (books.get(id).dueDay < p.day) return { ok: false };
        }
        if (member.owed >= BLOCK_THRESHOLD) return { ok: false };

        if (book.status === 'aside') {
          book.holdLine.shift();
          member.holds.delete(bookId);
        }
        book.status = 'loan';
        book.loanMember = memberId;
        book.dueDay = p.day + LOAN_DAYS;
        book.renewals = 0;
        book.readyUntilDay = null;
        member.loans.add(bookId);
        return { ok: true, dueDate: formatDay(book.dueDay) };
      } catch {
        return { ok: false };
      }
    },

    returnBook(input) {
      try {
        const p = prepare(input);
        if (!p) return { ok: false };
        const { memberId, bookId } = p.a;
        if (!validId(memberId) || !validId(bookId)) return { ok: false };
        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return { ok: false };
        if (book.status !== 'loan' || book.loanMember !== memberId) return { ok: false };

        const late = p.day - book.dueDay;
        const chargeable = Math.max(0, late - GRACE_DAYS);
        const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);
        member.owed += fine;

        member.loans.delete(bookId);
        book.loanMember = null;
        book.dueDay = null;
        book.renewals = 0;
        if (book.holdLine.length > 0) {
          book.status = 'aside';
          book.readyUntilDay = p.day + PICKUP_DAYS;
        } else {
          book.status = 'available';
          book.readyUntilDay = null;
        }
        return { ok: true, fine };
      } catch {
        return { ok: false };
      }
    },

    renew(input) {
      try {
        const p = prepare(input);
        if (!p) return { ok: false };
        const { memberId, bookId } = p.a;
        if (!validId(memberId) || !validId(bookId)) return { ok: false };
        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return { ok: false };
        if (book.status !== 'loan' || book.loanMember !== memberId) return { ok: false };
        if (p.day > book.dueDay) return { ok: false };
        if (book.renewals >= MAX_RENEWALS) return { ok: false };
        if (book.holdLine.length > 0) return { ok: false };
        if (member.owed >= BLOCK_THRESHOLD) return { ok: false };

        book.dueDay = p.day + LOAN_DAYS;
        book.renewals += 1;
        return { ok: true, dueDate: formatDay(book.dueDay) };
      } catch {
        return { ok: false };
      }
    },

    placeHold(input) {
      try {
        const p = prepare(input);
        if (!p) return { ok: false };
        const { memberId, bookId } = p.a;
        if (!validId(memberId) || !validId(bookId)) return { ok: false };
        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return { ok: false };
        if (book.status === 'available') return { ok: false };
        if (book.status === 'loan' && book.loanMember === memberId) return { ok: false };
        if (book.holdLine.includes(memberId)) return { ok: false };

        book.holdLine.push(memberId);
        member.holds.add(bookId);
        return { ok: true, position: book.holdLine.length };
      } catch {
        return { ok: false };
      }
    },

    payFine(input) {
      try {
        const p = prepare(input);
        if (!p) return { ok: false };
        const { memberId, amount } = p.a;
        if (!validId(memberId) || !validAmount(amount)) return { ok: false };
        const member = members.get(memberId);
        if (!member) return { ok: false };
        if (amount > member.owed) return { ok: false };

        member.owed -= amount;
        return { ok: true, owed: member.owed };
      } catch {
        return { ok: false };
      }
    },

    getMember(input) {
      try {
        const p = prepare(input);
        if (!p) return { ok: false };
        const { memberId } = p.a;
        if (!validId(memberId)) return { ok: false };
        const member = members.get(memberId);
        if (!member) return { ok: false };

        const loans = [];
        for (const bookId of member.loans) {
          const b = books.get(bookId);
          loans.push({ bookId, dueDate: formatDay(b.dueDay) });
        }

        const holds = [];
        for (const bookId of member.holds) {
          const b = books.get(bookId);
          const idx = b.holdLine.indexOf(memberId);
          const setAside = b.status === 'aside' && idx === 0;
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: setAside ? formatDay(b.readyUntilDay) : null,
          });
        }

        return { loans, owed: member.owed, holds };
      } catch {
        return { ok: false };
      }
    },
  };
}

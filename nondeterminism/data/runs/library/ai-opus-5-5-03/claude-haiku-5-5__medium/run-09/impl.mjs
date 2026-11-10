const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE_PER_LOAN = 1000;
const BORROW_BLOCK_OWED = 500;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

// Returns integer day number (days since 1970-01-01 UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getTime() / MS_PER_DAY;
}

function formatDate(n) {
  const t = new Date(n * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isObj(v) {
  return v !== null && typeof v === 'object';
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isAmount(v) {
  return Number.isSafeInteger(v) && v > 0;
}

const MAX_DAY = parseDate('9999-12-31');

export function createLibrary() {
  const members = new Map(); // memberId -> { owed }
  const books = new Map();   // bookId -> { loan: null | { memberId, dueDay, renewals, seq }, queue: [] }
  let clock = null;
  let loanSeq = 0;
  let holdSeq = 0;

  // §5 Hold processing
  function processHolds(D) {
    for (const book of books.values()) {
      while (
        book.queue.length > 0 &&
        book.queue[0].readyUntil !== null &&
        book.queue[0].readyUntil < D
      ) {
        const old = book.queue.shift();
        if (book.queue.length > 0) {
          const E = old.readyUntil + 1;
          book.queue[0].readyUntil = E + PICKUP_DAYS;
        }
      }
    }
  }

  // §4.4 Clock handling. Returns day number, or null if the date fails.
  function advance(dateStr) {
    const D = parseDate(dateStr);
    if (D === null) return null;
    if (clock !== null && D < clock) return null;
    clock = D;
    processHolds(D);
    return D;
  }

  function activeLoanCount(memberId) {
    let n = 0;
    for (const book of books.values()) {
      if (book.loan !== null && book.loan.memberId === memberId) n++;
    }
    return n;
  }

  return {
    addBook(args) {
      try {
        if (!isObj(args) || !isId(args.bookId)) return { ok: false };
        if (books.has(args.bookId)) return { ok: false };
        books.set(args.bookId, { loan: null, queue: [] });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },

    addMember(args) {
      try {
        if (!isObj(args) || !isId(args.memberId)) return { ok: false };
        if (members.has(args.memberId)) return { ok: false };
        members.set(args.memberId, { owed: 0 });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },

    borrow(args) {
      try {
        if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return { ok: false };
        const D = advance(args.date);
        if (D === null) return { ok: false };
        const member = members.get(args.memberId);
        const book = books.get(args.bookId);
        if (!member || !book) return { ok: false };
        if (book.loan !== null) return { ok: false };
        const head = book.queue[0];
        const setAside = head !== undefined && head.readyUntil !== null;
        if (setAside && head.memberId !== args.memberId) return { ok: false };
        if (member.owed >= BORROW_BLOCK_OWED) return { ok: false };
        if (activeLoanCount(args.memberId) >= MAX_LOANS) return { ok: false };
        const dueDay = D + LOAN_DAYS;
        if (dueDay > MAX_DAY) return { ok: false };

        if (setAside) book.queue.shift();
        book.loan = { memberId: args.memberId, dueDay, renewals: 0, seq: ++loanSeq };
        return { ok: true, dueDate: formatDate(dueDay) };
      } catch {
        return { ok: false };
      }
    },

    returnBook(args) {
      try {
        if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return { ok: false };
        const D = advance(args.date);
        if (D === null) return { ok: false };
        const member = members.get(args.memberId);
        const book = books.get(args.bookId);
        if (!member || !book) return { ok: false };
        if (book.loan === null || book.loan.memberId !== args.memberId) return { ok: false };

        const daysLate = D - book.loan.dueDay;
        let fine = 0;
        if (daysLate > GRACE_DAYS) {
          fine = Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);
        }

        member.owed += fine;
        book.loan = null;
        if (book.queue.length > 0) {
          book.queue[0].readyUntil = D + PICKUP_DAYS;
        }
        return { ok: true, fine };
      } catch {
        return { ok: false };
      }
    },

    renew(args) {
      try {
        if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return { ok: false };
        const D = advance(args.date);
        if (D === null) return { ok: false };
        const member = members.get(args.memberId);
        const book = books.get(args.bookId);
        if (!member || !book) return { ok: false };
        const loan = book.loan;
        if (loan === null || loan.memberId !== args.memberId) return { ok: false };
        if (D > loan.dueDay) return { ok: false };
        if (loan.renewals >= MAX_RENEWALS) return { ok: false };
        if (book.queue.length > 0) return { ok: false };
        const newDue = loan.dueDay + LOAN_DAYS;
        if (newDue > MAX_DAY) return { ok: false };

        loan.dueDay = newDue;
        loan.renewals += 1;
        return { ok: true, dueDate: formatDate(newDue) };
      } catch {
        return { ok: false };
      }
    },

    placeHold(args) {
      try {
        if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return { ok: false };
        const D = advance(args.date);
        if (D === null) return { ok: false };
        const member = members.get(args.memberId);
        const book = books.get(args.bookId);
        if (!member || !book) return { ok: false };
        // Available: no loan and empty queue.
        if (book.loan === null && book.queue.length === 0) return { ok: false };
        if (book.loan !== null && book.loan.memberId === args.memberId) return { ok: false };
        if (book.queue.some((h) => h.memberId === args.memberId)) return { ok: false };

        book.queue.push({ memberId: args.memberId, readyUntil: null, seq: ++holdSeq });
        return { ok: true, position: book.queue.length };
      } catch {
        return { ok: false };
      }
    },

    payFine(args) {
      try {
        if (!isObj(args) || !isId(args.memberId) || !isAmount(args.amount)) return { ok: false };
        const D = advance(args.date);
        if (D === null) return { ok: false };
        const member = members.get(args.memberId);
        if (!member) return { ok: false };
        if (args.amount > member.owed) return { ok: false };

        member.owed -= args.amount;
        return { ok: true, owed: member.owed };
      } catch {
        return { ok: false };
      }
    },

    getMember(args) {
      try {
        if (!isObj(args) || !isId(args.memberId)) return { ok: false };
        const D = advance(args.date);
        if (D === null) return { ok: false };
        const member = members.get(args.memberId);
        if (!member) return { ok: false };

        const loanRows = [];
        for (const [bookId, book] of books) {
          if (book.loan !== null && book.loan.memberId === args.memberId) {
            loanRows.push({ seq: book.loan.seq, bookId, dueDay: book.loan.dueDay });
          }
        }
        loanRows.sort((a, b) => a.seq - b.seq);
        const loans = loanRows.map((r) => ({ bookId: r.bookId, dueDate: formatDate(r.dueDay) }));

        const holdRows = [];
        for (const [bookId, book] of books) {
          book.queue.forEach((h, i) => {
            if (h.memberId === args.memberId) {
              holdRows.push({
                seq: h.seq,
                bookId,
                position: i + 1,
                readyUntil: h.readyUntil === null ? null : formatDate(h.readyUntil),
              });
            }
          });
        }
        holdRows.sort((a, b) => a.seq - b.seq);
        const holds = holdRows.map((r) => ({
          bookId: r.bookId,
          position: r.position,
          readyUntil: r.readyUntil,
        }));

        return { ok: true, loans, owed: member.owed, holds };
      } catch {
        return { ok: false };
      }
    },
  };
}

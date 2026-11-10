const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE_PER_LOAN = 500;
const BLOCK_THRESHOLD = 500;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(s) {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  return dt.getTime();
}

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(parseDate(s));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function formatDate(t) {
  const dt = new Date(t);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(s, n) {
  return formatDate(parseDate(s) + n * MS_PER_DAY);
}

function diffDays(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / MS_PER_DAY);
}

function isObj(v) {
  return v !== null && typeof v === 'object';
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function guard(fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch {
      return { ok: false, reason: 'internal error' };
    }
  };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { bookId, status, queue: [{ memberId, seq, readyFrom, readyUntil }] }
  const members = new Map(); // memberId -> { memberId, owed }
  const loans = [];          // { memberId, bookId, borrowDate, dueDate, renewals, seq }, creation order
  let seqCounter = 0;

  const fail = (reason) => ({ ok: false, reason });

  function advance(date) {
    for (const book of books.values()) {
      while (book.status === 'reserved') {
        const first = book.queue[0];
        if (first.readyUntil >= date) break;
        book.queue.shift();
        const nextStart = addDays(first.readyUntil, 1);
        if (book.queue.length === 0) {
          book.status = 'shelf';
          break;
        }
        const next = book.queue[0];
        next.readyFrom = nextStart;
        next.readyUntil = addDays(nextStart, PICKUP_DAYS - 1);
      }
    }
  }

  function countLoans(memberId) {
    let n = 0;
    for (const l of loans) if (l.memberId === memberId) n++;
    return n;
  }

  function countHolds(memberId) {
    let n = 0;
    for (const b of books.values()) {
      for (const e of b.queue) if (e.memberId === memberId) n++;
    }
    return n;
  }

  function findLoanIndex(memberId, bookId) {
    return loans.findIndex((l) => l.memberId === memberId && l.bookId === bookId);
  }

  // Shared preamble: shape check, then advance if date is valid.
  // Returns false if args is not an object.
  function preamble(args) {
    if (!isObj(args)) return false;
    if (isValidDate(args.date)) advance(args.date);
    return true;
  }

  const api = {
    addBook: guard((args) => {
      if (!isObj(args)) return fail('invalid arguments');
      const { bookId } = args;
      if (!isId(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { bookId, status: 'shelf', queue: [] });
      return { ok: true };
    }),

    addMember: guard((args) => {
      if (!isObj(args)) return fail('invalid arguments');
      const { memberId } = args;
      if (!isId(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('member exists');
      members.set(memberId, { memberId, owed: 0 });
      return { ok: true };
    }),

    borrow: guard((args) => {
      if (!preamble(args)) return fail('invalid arguments');
      const { memberId, bookId, date } = args;
      if (!isId(memberId) || !isId(bookId) || !isValidDate(date)) return fail('invalid input');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      const book = books.get(bookId);
      if (!book) return fail('unknown book');
      if (book.status === 'loaned') return fail('book on loan');
      if (book.status === 'reserved' && book.queue[0].memberId !== memberId) {
        return fail('reserved for another member');
      }
      if (member.owed >= BLOCK_THRESHOLD) return fail('owes too much');
      if (loans.some((l) => l.memberId === memberId && l.dueDate < date)) {
        return fail('overdue loan');
      }
      if (countLoans(memberId) >= MAX_LOANS) return fail('loan limit');

      if (book.status === 'reserved') book.queue.shift(); // pickup
      book.status = 'loaned';
      const dueDate = addDays(date, LOAN_DAYS);
      loans.push({
        memberId,
        bookId,
        borrowDate: date,
        dueDate,
        renewals: 0,
        seq: ++seqCounter,
      });
      return { ok: true, dueDate };
    }),

    returnBook: guard((args) => {
      if (!preamble(args)) return fail('invalid arguments');
      const { memberId, bookId, date } = args;
      if (!isId(memberId) || !isId(bookId) || !isValidDate(date)) return fail('invalid input');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      const book = books.get(bookId);
      if (!book) return fail('unknown book');
      const idx = findLoanIndex(memberId, bookId);
      if (idx < 0) return fail('no such loan');

      const loan = loans[idx];
      const daysLate = Math.max(0, diffDays(loan.dueDate, date));
      const fine = Math.min(
        MAX_FINE_PER_LOAN,
        FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS)
      );

      loans.splice(idx, 1);
      member.owed += fine;

      if (book.queue.length === 0) {
        book.status = 'shelf';
      } else {
        book.status = 'reserved';
        const first = book.queue[0];
        first.readyFrom = date;
        first.readyUntil = addDays(date, PICKUP_DAYS - 1);
      }
      return { ok: true, fine };
    }),

    renew: guard((args) => {
      if (!preamble(args)) return fail('invalid arguments');
      const { memberId, bookId, date } = args;
      if (!isId(memberId) || !isId(bookId) || !isValidDate(date)) return fail('invalid input');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      const book = books.get(bookId);
      if (!book) return fail('unknown book');
      const idx = findLoanIndex(memberId, bookId);
      if (idx < 0) return fail('no such loan');
      const loan = loans[idx];
      if (date > loan.dueDate) return fail('overdue');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (book.queue.length > 0) return fail('someone is waiting');
      if (member.owed >= BLOCK_THRESHOLD) return fail('owes too much');

      loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: loan.dueDate };
    }),

    placeHold: guard((args) => {
      if (!preamble(args)) return fail('invalid arguments');
      const { memberId, bookId, date } = args;
      if (!isId(memberId) || !isId(bookId) || !isValidDate(date)) return fail('invalid input');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      const book = books.get(bookId);
      if (!book) return fail('unknown book');
      if (book.status === 'shelf') return fail('available on shelf');
      if (findLoanIndex(memberId, bookId) >= 0) return fail('already on loan');
      if (book.queue.some((e) => e.memberId === memberId)) return fail('already in queue');
      if (countHolds(memberId) >= MAX_HOLDS) return fail('hold limit');

      book.queue.push({ memberId, seq: ++seqCounter, readyFrom: null, readyUntil: null });
      return { ok: true, position: book.queue.length };
    }),

    payFine: guard((args) => {
      if (!preamble(args)) return fail('invalid arguments');
      const { memberId, amount, date } = args;
      if (!isId(memberId) || !isValidDate(date)) return fail('invalid input');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (!Number.isInteger(amount) || amount < 1) return fail('invalid amount');
      if (amount > member.owed) return fail('overpayment');

      member.owed -= amount;
      return { ok: true, owed: member.owed };
    }),

    getMember: guard((args) => {
      if (!preamble(args)) return fail('invalid arguments');
      const { memberId, date } = args;
      if (!isId(memberId) || !isValidDate(date)) return fail('invalid input');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');

      const loansOut = loans
        .filter((l) => l.memberId === memberId)
        .map((l) => ({ bookId: l.bookId, dueDate: l.dueDate }));

      const found = [];
      for (const book of books.values()) {
        book.queue.forEach((e, i) => {
          if (e.memberId === memberId) {
            found.push({
              seq: e.seq,
              bookId: book.bookId,
              position: i + 1,
              readyUntil: e.readyUntil === null ? null : e.readyUntil,
            });
          }
        });
      }
      found.sort((a, b) => a.seq - b.seq);
      const holdsOut = found.map(({ bookId, position, readyUntil }) => ({
        bookId,
        position,
        readyUntil,
      }));

      return { loans: loansOut, owed: member.owed, holds: holdsOut };
    }),
  };

  return api;
}

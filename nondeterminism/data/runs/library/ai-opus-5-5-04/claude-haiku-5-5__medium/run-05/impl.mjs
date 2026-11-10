const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE_PER_LOAN = 500;
const BLOCK_THRESHOLD = 500;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const DAY_MS = 86400000;

// Returns the epoch ms (UTC midnight) for a valid 'YYYY-MM-DD' string, or null.
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return t.getTime();
}

function formatMs(ms) {
  const t = new Date(ms);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(dateStr, n) {
  return formatMs(parseDate(dateStr) + n * DAY_MS);
}

function diffDays(a, b) {
  return (parseDate(b) - parseDate(a)) / DAY_MS;
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isObj(x) {
  return x !== null && typeof x === 'object';
}

function fail(reason) {
  return { ok: false, reason };
}

function guard(fn) {
  try {
    return fn();
  } catch {
    return { ok: false, reason: 'error' };
  }
}

export function createLibrary() {
  // bookId -> { status: 'shelf'|'loaned'|'reserved', queue: [{ memberId, seq, readyFrom, readyUntil }] }
  const books = new Map();
  // memberId -> { owed: number, loans: [{ bookId, borrowDate, dueDate, renewals }] }
  const members = new Map();
  let holdSeq = 0;

  function setAside(entry, from) {
    entry.readyFrom = from;
    entry.readyUntil = addDays(from, PICKUP_DAYS - 1);
  }

  // §5.2 hold expiry processing.
  function advance(date) {
    for (const book of books.values()) {
      if (book.status !== 'reserved') continue;
      while (
        book.queue.length > 0 &&
        book.queue[0].readyUntil !== null &&
        book.queue[0].readyUntil < date
      ) {
        const expired = book.queue.shift();
        const nextStart = addDays(expired.readyUntil, 1);
        if (book.queue.length === 0) {
          book.status = 'shelf';
          break;
        }
        setAside(book.queue[0], nextStart);
      }
    }
  }

  function countHolds(memberId) {
    let n = 0;
    for (const book of books.values()) {
      for (const e of book.queue) {
        if (e.memberId === memberId) n++;
      }
    }
    return n;
  }

  return {
    addBook(args) {
      return guard(() => {
        if (!isObj(args) || !isId(args.bookId)) return fail('invalid id');
        if (books.has(args.bookId)) return fail('exists');
        books.set(args.bookId, { status: 'shelf', queue: [] });
        return { ok: true };
      });
    },

    addMember(args) {
      return guard(() => {
        if (!isObj(args) || !isId(args.memberId)) return fail('invalid id');
        if (members.has(args.memberId)) return fail('exists');
        members.set(args.memberId, { owed: 0, loans: [] });
        return { ok: true };
      });
    },

    borrow(args) {
      return guard(() => {
        if (!isObj(args)) return fail('invalid args');
        const { memberId, bookId, date } = args;
        if (parseDate(date) === null) return fail('invalid date');
        advance(date);
        if (!isId(memberId) || !isId(bookId)) return fail('invalid id');

        const member = members.get(memberId);
        if (!member) return fail('unknown member');
        const book = books.get(bookId);
        if (!book) return fail('unknown book');
        if (book.status === 'loaned') return fail('loaned');

        let pickup = false;
        if (book.status === 'reserved') {
          if (book.queue[0].memberId !== memberId) return fail('reserved for another');
          pickup = true;
        }
        if (member.owed >= BLOCK_THRESHOLD) return fail('owes too much');
        if (member.loans.some((l) => l.dueDate < date)) return fail('overdue loan');
        if (member.loans.length >= MAX_LOANS) return fail('max loans');

        const dueDate = addDays(date, LOAN_DAYS);
        if (pickup) book.queue.shift();
        book.status = 'loaned';
        member.loans.push({ bookId, borrowDate: date, dueDate, renewals: 0 });
        return { ok: true, dueDate };
      });
    },

    returnBook(args) {
      return guard(() => {
        if (!isObj(args)) return fail('invalid args');
        const { memberId, bookId, date } = args;
        if (parseDate(date) === null) return fail('invalid date');
        advance(date);
        if (!isId(memberId) || !isId(bookId)) return fail('invalid id');

        const member = members.get(memberId);
        if (!member) return fail('unknown member');
        const book = books.get(bookId);
        if (!book) return fail('unknown book');
        const idx = member.loans.findIndex((l) => l.bookId === bookId);
        if (idx < 0) return fail('no such loan');

        const loan = member.loans[idx];
        const daysLate = Math.max(0, diffDays(loan.dueDate, date));
        const fine = Math.min(
          MAX_FINE_PER_LOAN,
          FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS)
        );

        member.loans.splice(idx, 1);
        member.owed += fine;
        if (book.queue.length === 0) {
          book.status = 'shelf';
        } else {
          book.status = 'reserved';
          setAside(book.queue[0], date);
        }
        return { ok: true, fine };
      });
    },

    renew(args) {
      return guard(() => {
        if (!isObj(args)) return fail('invalid args');
        const { memberId, bookId, date } = args;
        if (parseDate(date) === null) return fail('invalid date');
        advance(date);
        if (!isId(memberId) || !isId(bookId)) return fail('invalid id');

        const member = members.get(memberId);
        if (!member) return fail('unknown member');
        const book = books.get(bookId);
        if (!book) return fail('unknown book');
        const loan = member.loans.find((l) => l.bookId === bookId);
        if (!loan) return fail('no such loan');
        if (date > loan.dueDate) return fail('overdue');
        if (loan.renewals >= MAX_RENEWALS) return fail('max renewals');
        if (book.queue.length > 0) return fail('someone waiting');
        if (member.owed >= BLOCK_THRESHOLD) return fail('owes too much');

        loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
        loan.renewals += 1;
        return { ok: true, dueDate: loan.dueDate };
      });
    },

    placeHold(args) {
      return guard(() => {
        if (!isObj(args)) return fail('invalid args');
        const { memberId, bookId, date } = args;
        if (parseDate(date) === null) return fail('invalid date');
        advance(date);
        if (!isId(memberId) || !isId(bookId)) return fail('invalid id');

        const member = members.get(memberId);
        if (!member) return fail('unknown member');
        const book = books.get(bookId);
        if (!book) return fail('unknown book');
        if (book.status === 'shelf') return fail('available');
        if (member.loans.some((l) => l.bookId === bookId)) return fail('already on loan');
        if (book.queue.some((e) => e.memberId === memberId)) return fail('already in queue');
        if (countHolds(memberId) >= MAX_HOLDS) return fail('max holds');

        book.queue.push({
          memberId,
          seq: ++holdSeq,
          readyFrom: null,
          readyUntil: null,
        });
        return { ok: true, position: book.queue.length };
      });
    },

    payFine(args) {
      return guard(() => {
        if (!isObj(args)) return fail('invalid args');
        const { memberId, amount, date } = args;
        if (parseDate(date) === null) return fail('invalid date');
        advance(date);
        if (!isId(memberId)) return fail('invalid id');

        const member = members.get(memberId);
        if (!member) return fail('unknown member');
        if (!Number.isInteger(amount) || amount < 1) return fail('invalid amount');
        if (amount > member.owed) return fail('overpayment');

        member.owed -= amount;
        return { ok: true, owed: member.owed };
      });
    },

    getMember(args) {
      return guard(() => {
        if (!isObj(args)) return fail('invalid args');
        const { memberId, date } = args;
        if (parseDate(date) === null) return fail('invalid date');
        advance(date);
        if (!isId(memberId)) return fail('invalid id');

        const member = members.get(memberId);
        if (!member) return fail('unknown member');

        const loans = member.loans.map((l) => ({ bookId: l.bookId, dueDate: l.dueDate }));

        const found = [];
        for (const [bookId, book] of books) {
          book.queue.forEach((e, i) => {
            if (e.memberId === memberId) {
              found.push({
                seq: e.seq,
                bookId,
                position: i + 1,
                readyUntil: e.readyUntil === null ? null : e.readyUntil,
              });
            }
          });
        }
        found.sort((a, b) => a.seq - b.seq);
        const holds = found.map((h) => ({
          bookId: h.bookId,
          position: h.position,
          readyUntil: h.readyUntil,
        }));

        return { loans, owed: member.owed, holds };
      });
    },
  };
}

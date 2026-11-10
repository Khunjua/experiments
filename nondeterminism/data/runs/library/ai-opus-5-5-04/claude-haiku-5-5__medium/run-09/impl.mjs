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

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

// Returns epoch milliseconds (UTC midnight) for a valid 'YYYY-MM-DD' string, else null.
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.getTime();
}

function isValidDate(s) {
  return parseDate(s) !== null;
}

function formatDate(ms) {
  const t = new Date(ms);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(s, n) {
  return formatDate(parseDate(s) + n * MS_PER_DAY);
}

function diffDays(a, b) {
  return (parseDate(b) - parseDate(a)) / MS_PER_DAY;
}

function argsOf(a) {
  return a !== null && typeof a === 'object' ? a : {};
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  // bookId -> { bookId, status, queue: [{ memberId, seq, readyFrom, readyUntil }], loan }
  const books = new Map();
  // memberId -> { memberId, owed, loans: [loan] }
  const members = new Map();
  // loan -> { memberId, bookId, borrowDate, dueDate, renewals }
  let holdSeq = 0;

  // Hold expiry (section 5.2). Runs for every book; result is independent of call timing.
  function advance(date) {
    for (const book of books.values()) {
      while (
        book.status === 'reserved' &&
        book.queue.length > 0 &&
        book.queue[0].readyUntil < date
      ) {
        const expired = book.queue.shift();
        const nextStart = addDays(expired.readyUntil, 1);
        if (book.queue.length === 0) {
          book.status = 'shelf';
        } else {
          const first = book.queue[0];
          first.readyFrom = nextStart;
          first.readyUntil = addDays(nextStart, PICKUP_DAYS - 1);
        }
      }
    }
  }

  function countHoldsOf(memberId) {
    let n = 0;
    for (const book of books.values()) {
      if (book.queue.some((e) => e.memberId === memberId)) n++;
    }
    return n;
  }

  return {
    addBook(a) {
      const { bookId } = argsOf(a);
      if (!isId(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { bookId, status: 'shelf', queue: [], loan: null });
      return { ok: true };
    },

    addMember(a) {
      const { memberId } = argsOf(a);
      if (!isId(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('member exists');
      members.set(memberId, { memberId, owed: 0, loans: [] });
      return { ok: true };
    },

    borrow(a) {
      const { memberId, bookId, date } = argsOf(a);
      if (!isId(memberId) || !isId(bookId) || !isValidDate(date)) return fail('invalid');
      advance(date);

      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      const book = books.get(bookId);
      if (!book) return fail('unknown book');
      if (book.status === 'loaned') return fail('book on loan');
      if (book.status === 'reserved' && book.queue[0].memberId !== memberId) {
        return fail('reserved for another member');
      }
      if (member.owed >= BLOCK_THRESHOLD) return fail('owed too much');
      if (member.loans.some((l) => l.dueDate < date)) return fail('overdue loan');
      if (member.loans.length >= MAX_LOANS) return fail('too many loans');

      if (book.status === 'reserved') {
        // Pickup: remove the member's set-aside hold; others keep their order.
        book.queue.shift();
      }
      const loan = {
        memberId,
        bookId,
        borrowDate: date,
        dueDate: addDays(date, LOAN_DAYS),
        renewals: 0,
      };
      book.status = 'loaned';
      book.loan = loan;
      member.loans.push(loan);
      return { ok: true, dueDate: loan.dueDate };
    },

    returnBook(a) {
      const { memberId, bookId, date } = argsOf(a);
      if (!isId(memberId) || !isId(bookId) || !isValidDate(date)) return fail('invalid');
      advance(date);

      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      const book = books.get(bookId);
      if (!book) return fail('unknown book');
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail('no such loan');

      const daysLate = Math.max(0, diffDays(loan.dueDate, date));
      const fine = Math.min(
        MAX_FINE_PER_LOAN,
        FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS)
      );

      member.loans = member.loans.filter((l) => l !== loan);
      book.loan = null;
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
    },

    renew(a) {
      const { memberId, bookId, date } = argsOf(a);
      if (!isId(memberId) || !isId(bookId) || !isValidDate(date)) return fail('invalid');
      advance(date);

      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      const book = books.get(bookId);
      if (!book) return fail('unknown book');
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail('no such loan');
      if (date > loan.dueDate) return fail('overdue');
      if (loan.renewals >= MAX_RENEWALS) return fail('max renewals');
      if (book.queue.length > 0) return fail('book wanted');
      if (member.owed >= BLOCK_THRESHOLD) return fail('owed too much');

      loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold(a) {
      const { memberId, bookId, date } = argsOf(a);
      if (!isId(memberId) || !isId(bookId) || !isValidDate(date)) return fail('invalid');
      advance(date);

      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      const book = books.get(bookId);
      if (!book) return fail('unknown book');
      if (book.status === 'shelf') return fail('available on shelf');
      if (book.loan && book.loan.memberId === memberId) return fail('already on loan');
      if (book.queue.some((e) => e.memberId === memberId)) return fail('already holding');
      if (countHoldsOf(memberId) >= MAX_HOLDS) return fail('too many holds');

      book.queue.push({ memberId, seq: holdSeq++, readyFrom: null, readyUntil: null });
      return { ok: true, position: book.queue.length };
    },

    payFine(a) {
      const { memberId, amount, date } = argsOf(a);
      if (!isId(memberId) || !isValidDate(date)) return fail('invalid');
      advance(date);

      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (!Number.isInteger(amount) || amount < 1) return fail('invalid amount');
      if (amount > member.owed) return fail('overpayment');

      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember(a) {
      const { memberId, date } = argsOf(a);
      if (!isId(memberId) || !isValidDate(date)) return fail('invalid');
      advance(date);

      const member = members.get(memberId);
      if (!member) return fail('unknown member');

      const holds = [];
      for (const book of books.values()) {
        const idx = book.queue.findIndex((e) => e.memberId === memberId);
        if (idx >= 0) {
          const entry = book.queue[idx];
          const setAside = idx === 0 && book.status === 'reserved';
          holds.push({
            seq: entry.seq,
            bookId: book.bookId,
            position: idx + 1,
            readyUntil: setAside ? entry.readyUntil : null,
          });
        }
      }
      holds.sort((x, y) => x.seq - y.seq);

      return {
        loans: member.loans.map((l) => ({ bookId: l.bookId, dueDate: l.dueDate })),
        owed: member.owed,
        holds: holds.map((h) => ({
          bookId: h.bookId,
          position: h.position,
          readyUntil: h.readyUntil,
        })),
      };
    },
  };
}

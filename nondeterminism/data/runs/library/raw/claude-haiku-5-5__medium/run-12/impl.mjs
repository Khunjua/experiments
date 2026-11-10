const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const RENEWAL_DAYS = 21;
const MAX_RENEWALS = 2;
const PICKUP_DAYS = 7;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;

function toDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fromDay(toDay(s) + n);
}

function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fromDay(toDay(s)) === s;
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

export function createLibrary() {
  const members = new Map(); // memberId -> { owed }
  const books = new Map();   // bookId -> { loan: { memberId, dueDate, renewals } | null, queue: [{ memberId, readyUntil }] }

  const fail = () => ({ ok: false });
  const ok = (extra = {}) => ({ ok: true, ...extra });

  // Sets aside the first waiting member if the book is free and nobody is set aside yet.
  function setAside(book, startDay) {
    if (book.loan === null && book.queue.length > 0 && book.queue[0].readyUntil === null) {
      book.queue[0].readyUntil = fromDay(startDay + PICKUP_DAYS - 1);
    }
  }

  // Drops set-aside holds whose pickup window has passed and passes the book to the next in line.
  function expire(date) {
    for (const book of books.values()) {
      while (book.queue.length > 0 && book.queue[0].readyUntil !== null && book.queue[0].readyUntil < date) {
        const freedDay = toDay(book.queue[0].readyUntil) + 1;
        book.queue.shift();
        setAside(book, freedDay);
      }
    }
  }

  function activeLoanCount(memberId) {
    let n = 0;
    for (const book of books.values()) {
      if (book.loan && book.loan.memberId === memberId) n++;
    }
    return n;
  }

  function activeHoldCount(memberId) {
    let n = 0;
    for (const book of books.values()) {
      if (book.queue.some((e) => e.memberId === memberId)) n++;
    }
    return n;
  }

  return {
    addBook(args) {
      const bookId = args?.bookId;
      if (!isId(bookId) || books.has(bookId)) return fail();
      books.set(bookId, { loan: null, queue: [] });
      return ok();
    },

    addMember(args) {
      const memberId = args?.memberId;
      if (!isId(memberId) || members.has(memberId)) return fail();
      members.set(memberId, { owed: 0 });
      return ok();
    },

    borrow(args) {
      const memberId = args?.memberId;
      const bookId = args?.bookId;
      const date = args?.date;
      if (!members.has(memberId) || !books.has(bookId) || !isDate(date)) return fail();
      expire(date);
      const book = books.get(bookId);
      if (book.loan) return fail();
      if (book.queue.length > 0 && book.queue[0].memberId !== memberId) return fail();
      if (activeLoanCount(memberId) >= MAX_LOANS) return fail();
      if (book.queue.length > 0) book.queue.shift();
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      return ok({ dueDate });
    },

    returnBook(args) {
      const memberId = args?.memberId;
      const bookId = args?.bookId;
      const date = args?.date;
      if (!members.has(memberId) || !books.has(bookId) || !isDate(date)) return fail();
      expire(date);
      const book = books.get(bookId);
      if (!book.loan || book.loan.memberId !== memberId) return fail();
      const lateDays = toDay(date) - toDay(book.loan.dueDate) - GRACE_DAYS;
      const fine = lateDays > 0 ? Math.min(lateDays * FINE_PER_DAY, FINE_CAP) : 0;
      book.loan = null;
      members.get(memberId).owed += fine;
      setAside(book, toDay(date));
      return ok({ fine });
    },

    renew(args) {
      const memberId = args?.memberId;
      const bookId = args?.bookId;
      const date = args?.date;
      if (!members.has(memberId) || !books.has(bookId) || !isDate(date)) return fail();
      expire(date);
      const book = books.get(bookId);
      if (!book.loan || book.loan.memberId !== memberId) return fail();
      if (book.loan.renewals >= MAX_RENEWALS) return fail();
      if (book.queue.length > 0) return fail();
      if (date > book.loan.dueDate) return fail();
      book.loan.renewals += 1;
      book.loan.dueDate = addDays(date, RENEWAL_DAYS);
      return ok({ dueDate: book.loan.dueDate });
    },

    placeHold(args) {
      const memberId = args?.memberId;
      const bookId = args?.bookId;
      const date = args?.date;
      if (!members.has(memberId) || !books.has(bookId) || !isDate(date)) return fail();
      expire(date);
      const book = books.get(bookId);
      if (!book.loan && book.queue.length === 0) return fail();
      if (book.loan && book.loan.memberId === memberId) return fail();
      if (book.queue.some((e) => e.memberId === memberId)) return fail();
      if (activeHoldCount(memberId) >= MAX_HOLDS) return fail();
      book.queue.push({ memberId, readyUntil: null });
      return ok({ position: book.queue.length });
    },

    payFine(args) {
      const memberId = args?.memberId;
      const amount = args?.amount;
      const date = args?.date;
      if (!members.has(memberId) || !Number.isInteger(amount) || amount <= 0 || !isDate(date)) return fail();
      expire(date);
      const member = members.get(memberId);
      if (amount > member.owed) return fail();
      member.owed -= amount;
      return ok({ owed: member.owed });
    },

    getMember(args) {
      const memberId = args?.memberId;
      const date = args?.date;
      const member = members.get(memberId);
      if (!isDate(date) || !member) return { loans: [], owed: 0, holds: [] };
      expire(date);
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: book.loan.dueDate });
        }
        const i = book.queue.findIndex((e) => e.memberId === memberId);
        if (i >= 0) {
          holds.push({ bookId, position: i + 1, readyUntil: book.queue[i].readyUntil });
        }
      }
      return { loans, owed: member.owed, holds };
    },
  };
}

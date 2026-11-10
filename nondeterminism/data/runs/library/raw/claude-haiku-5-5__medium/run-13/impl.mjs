const LOAN_DAYS = 21;
const RENEWAL_DAYS = 21;
const MAX_RENEWALS = 2;
const PICKUP_DAYS = 7;
const GRACE_DAYS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const DAY_MS = 86400000;

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function dayNum(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function dayStr(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return dayStr(dayNum(s) + n);
}

export function createLibrary() {
  // bookId -> { loan: null | { memberId, dueDate, renewals },
  //             ready: null | { memberId, readyUntil },
  //             queue: [memberId, ...] }   (waiting holds, not yet set aside)
  const books = new Map();
  const members = new Set();
  let owedByMember = new Map();

  const fail = () => ({ ok: false });

  function owed(memberId) {
    return owedByMember.get(memberId) || 0;
  }

  // Expire set-aside holds that were not picked up, passing the book on.
  function settle(book) {
    while (book.ready && book.ready.readyUntil !== null) {
      // Caller must have already validated the date; compare via stored ready window.
      break;
    }
  }

  function settleTo(book, date) {
    while (book.ready && dayNum(date) > dayNum(book.ready.readyUntil)) {
      if (book.queue.length === 0) {
        book.ready = null;
        break;
      }
      const freed = dayNum(book.ready.readyUntil) + 1;
      const next = book.queue.shift();
      book.ready = {
        memberId: next,
        readyUntil: dayStr(freed + PICKUP_DAYS - 1),
      };
    }
  }

  function settleAll(date) {
    for (const book of books.values()) settleTo(book, date);
  }

  // Book is free on `date`: set it aside for the next waiting member, if any.
  function offerToNext(book, date) {
    if (book.queue.length > 0) {
      const next = book.queue.shift();
      book.ready = { memberId: next, readyUntil: addDays(date, PICKUP_DAYS - 1) };
    } else {
      book.ready = null;
    }
  }

  function activeHoldCount(memberId) {
    let n = 0;
    for (const book of books.values()) {
      if (book.ready && book.ready.memberId === memberId) n++;
      else if (book.queue.includes(memberId)) n++;
    }
    return n;
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId) || books.has(bookId)) return fail();
      books.set(bookId, { loan: null, ready: null, queue: [] });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId) || members.has(memberId)) return fail();
      members.add(memberId);
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      if (!validId(memberId) || !validId(bookId) || !validDate(date)) return fail();
      if (!members.has(memberId)) return fail();
      const book = books.get(bookId);
      if (!book) return fail();

      settleAll(date);

      if (book.loan) return fail();
      if (book.ready && book.ready.memberId !== memberId) return fail();

      let loanCount = 0;
      for (const b of books.values()) {
        if (b.loan && b.loan.memberId === memberId) {
          if (dayNum(b.loan.dueDate) < dayNum(date)) return fail(); // has overdue loan
          loanCount++;
        }
      }
      if (loanCount >= MAX_LOANS) return fail();

      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      book.ready = null;
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      if (!validId(memberId) || !validId(bookId) || !validDate(date)) return fail();
      const book = books.get(bookId);
      if (!book) return fail();

      settleAll(date);

      if (!book.loan || book.loan.memberId !== memberId) return fail();

      const daysLate = dayNum(date) - dayNum(book.loan.dueDate);
      let fine = 0;
      if (daysLate > GRACE_DAYS) {
        fine = Math.min(MAX_FINE_PER_LOAN, (daysLate - GRACE_DAYS) * FINE_PER_DAY);
      }

      if (fine > 0) {
        owedByMember.set(memberId, owed(memberId) + fine);
      }

      book.loan = null;
      offerToNext(book, date);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      if (!validId(memberId) || !validId(bookId) || !validDate(date)) return fail();
      const book = books.get(bookId);
      if (!book) return fail();

      settleAll(date);

      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail();
      if (loan.renewals >= MAX_RENEWALS) return fail();
      if (dayNum(date) > dayNum(loan.dueDate)) return fail(); // overdue
      if (book.queue.length > 0) return fail(); // someone is waiting

      loan.renewals += 1;
      loan.dueDate = addDays(date, RENEWAL_DAYS);
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      if (!validId(memberId) || !validId(bookId) || !validDate(date)) return fail();
      if (!members.has(memberId)) return fail();
      const book = books.get(bookId);
      if (!book) return fail();

      settleAll(date);

      if (!book.loan) return fail(); // only books that are out
      if (book.loan.memberId === memberId) return fail();
      if (book.ready && book.ready.memberId === memberId) return fail();
      if (book.queue.includes(memberId)) return fail();
      if (activeHoldCount(memberId) >= MAX_HOLDS) return fail();

      book.queue.push(memberId);
      const position = (book.ready ? 1 : 0) + book.queue.length;
      return { ok: true, position };
    },

    payFine({ memberId, amount, date } = {}) {
      if (!validId(memberId) || !validDate(date)) return fail();
      if (!members.has(memberId)) return fail();
      if (!Number.isInteger(amount) || amount <= 0) return fail();
      const current = owed(memberId);
      if (amount > current) return fail();

      const remaining = current - amount;
      owedByMember.set(memberId, remaining);
      return { ok: true, owed: remaining };
    },

    getMember({ memberId, date } = {}) {
      if (!validId(memberId) || !validDate(date) || !members.has(memberId)) {
        return { ok: false, loans: [], owed: 0, holds: [] };
      }

      settleAll(date);

      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: book.loan.dueDate });
        }
        if (book.ready && book.ready.memberId === memberId) {
          holds.push({ bookId, position: 1, readyUntil: book.ready.readyUntil });
        } else {
          const idx = book.queue.indexOf(memberId);
          if (idx !== -1) {
            holds.push({
              bookId,
              position: (book.ready ? 1 : 0) + idx + 1,
              readyUntil: null,
            });
          }
        }
      }

      return { loans, owed: owed(memberId), holds };
    },
  };
}

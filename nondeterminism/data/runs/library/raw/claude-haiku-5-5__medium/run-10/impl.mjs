const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const PICKUP_DAYS = 3;
const DAY_MS = 86400000;

function addDays(date, n) {
  return new Date(Date.parse(date + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS);
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function fineFor(dueDate, returnDate) {
  const late = daysBetween(dueDate, returnDate);
  const chargeable = late - GRACE_DAYS;
  if (chargeable <= 0) return 0;
  return Math.min(chargeable * FINE_PER_DAY, FINE_CAP);
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan, ready, queue }
  const members = new Map(); // memberId -> { owed }

  // loan: null | { memberId, dueDate, renewals }
  // ready: null | { memberId, readyUntil }  (book set aside for a member)
  // queue: array of memberIds, index 0 = next

  function assignNext(book, date) {
    if (book.loan || book.ready) return;
    if (book.queue.length === 0) return;
    const memberId = book.queue.shift();
    book.ready = { memberId, readyUntil: addDays(date, PICKUP_DAYS) };
  }

  // Applies time-based expiry of set-aside holds up to and including `date`.
  function advance(date) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const book of books.values()) {
        if (book.ready && book.ready.readyUntil < date) {
          const lapse = addDays(book.ready.readyUntil, 1);
          book.ready = null;
          assignNext(book, lapse);
          changed = true;
        }
      }
    }
  }

  return {
    addBook({ bookId }) {
      if (!isId(bookId) || books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, ready: null, queue: [] });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (!isId(memberId) || members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      advance(date);
      const book = books.get(bookId);
      if (!book || !members.has(memberId)) return { ok: false };
      if (book.loan) return { ok: false };
      if (book.ready && book.ready.memberId !== memberId) return { ok: false };
      if (book.ready && book.ready.memberId === memberId) book.ready = null;
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      advance(date);
      const book = books.get(bookId);
      if (!book || !book.loan || book.loan.memberId !== memberId) return { ok: false };
      const fine = fineFor(book.loan.dueDate, date);
      members.get(memberId).owed += fine;
      book.loan = null;
      assignNext(book, date);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      advance(date);
      const book = books.get(bookId);
      if (!book || !book.loan || book.loan.memberId !== memberId) return { ok: false };
      if (date > book.loan.dueDate) return { ok: false };
      if (book.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (book.queue.length > 0) return { ok: false };
      book.loan.dueDate = addDays(date, LOAN_DAYS);
      book.loan.renewals += 1;
      return { ok: true, dueDate: book.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      advance(date);
      const book = books.get(bookId);
      if (!book || !members.has(memberId)) return { ok: false };
      if (!book.loan || book.loan.memberId === memberId) return { ok: false };
      if (book.queue.includes(memberId)) return { ok: false };
      book.queue.push(memberId);
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date }) {
      advance(date);
      const member = members.get(memberId);
      if (!member) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) return { ok: false };
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date }) {
      advance(date);
      const member = members.get(memberId);
      if (!member) return { loans: [], owed: 0, holds: [] };

      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: book.loan.dueDate });
        }
        if (book.ready && book.ready.memberId === memberId) {
          holds.push({ bookId, position: 0, readyUntil: book.ready.readyUntil });
        }
        const idx = book.queue.indexOf(memberId);
        if (idx >= 0) {
          holds.push({ bookId, position: idx + 1, readyUntil: null });
        }
      }
      return { loans, owed: member.owed, holds };
    },
  };
}

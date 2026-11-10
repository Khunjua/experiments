const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const PICKUP_DAYS = 3;
const GRACE_DAYS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const DAY_MS = 86400000;

function toMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(dateStr, n) {
  return new Date(toMs(dateStr) + n * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS);
}

function fineFor(daysLate) {
  if (daysLate <= GRACE_DAYS) return 0;
  return Math.min(FINE_PER_DAY * (daysLate - GRACE_DAYS), FINE_CAP);
}

// Fine accrued on a loan as of `date` that has not yet been charged.
function accrued(loan, date) {
  const late = daysBetween(loan.dueDate, date);
  return Math.max(0, fineFor(late) - loan.charged);
}

export function createLibrary() {
  // bookId -> { loan: null | { memberId, dueDate, renewals, charged }, queue: [{ memberId, readyUntil }] }
  // readyUntil is set only on the head of the queue while the book is not on loan.
  const books = new Map();
  // memberId -> { balance }
  const members = new Map();

  function syncBook(book, date) {
    while (
      !book.loan &&
      book.queue.length > 0 &&
      book.queue[0].readyUntil !== null &&
      book.queue[0].readyUntil < date
    ) {
      const expired = book.queue.shift();
      if (book.queue.length > 0) {
        book.queue[0].readyUntil = addDays(expired.readyUntil, PICKUP_DAYS);
      }
    }
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { balance: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      const book = books.get(bookId);
      if (!book || !members.has(memberId)) return { ok: false };
      syncBook(book, date);
      if (book.loan) return { ok: false };
      if (book.queue.length > 0) {
        const head = book.queue[0];
        if (head.readyUntil === null || head.memberId !== memberId) return { ok: false };
        book.queue.shift();
        if (book.queue.length > 0) book.queue[0].readyUntil = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0, charged: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      const book = books.get(bookId);
      if (!book || !members.has(memberId)) return { ok: false };
      syncBook(book, date);
      if (!book.loan || book.loan.memberId !== memberId) return { ok: false };
      const fine = accrued(book.loan, date);
      members.get(memberId).balance += fine;
      book.loan = null;
      if (book.queue.length > 0) {
        book.queue[0].readyUntil = addDays(date, PICKUP_DAYS - 1);
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      const book = books.get(bookId);
      if (!book || !members.has(memberId)) return { ok: false };
      syncBook(book, date);
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return { ok: false };
      if (book.queue.length > 0) return { ok: false };
      if (loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (date > loan.dueDate) return { ok: false };
      loan.renewals += 1;
      loan.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      const book = books.get(bookId);
      if (!book || !members.has(memberId)) return { ok: false };
      syncBook(book, date);
      if (!book.loan && book.queue.length === 0) return { ok: false };
      if (book.loan && book.loan.memberId === memberId) return { ok: false };
      if (book.queue.some((e) => e.memberId === memberId)) return { ok: false };
      book.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date }) {
      const member = members.get(memberId);
      if (!member) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0) return { ok: false };

      let total = member.balance;
      const memberLoans = [];
      for (const book of books.values()) {
        if (book.loan && book.loan.memberId === memberId) {
          memberLoans.push(book.loan);
          total += accrued(book.loan, date);
        }
      }
      if (amount > total) return { ok: false };

      // Settle accrued fines into the balance, then apply the payment.
      for (const loan of memberLoans) {
        const a = accrued(loan, date);
        loan.charged += a;
        member.balance += a;
      }
      member.balance -= amount;
      return { ok: true, owed: member.balance };
    },

    getMember({ memberId, date }) {
      const member = members.get(memberId);
      if (!member) return { loans: [], owed: 0, holds: [] };

      for (const book of books.values()) syncBook(book, date);

      const loans = [];
      const holds = [];
      let owed = member.balance;

      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: book.loan.dueDate });
          owed += accrued(book.loan, date);
        }
        const idx = book.queue.findIndex((e) => e.memberId === memberId);
        if (idx >= 0) {
          const entry = book.queue[idx];
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: !book.loan && idx === 0 ? entry.readyUntil : null,
          });
        }
      }

      return { loans, owed, holds };
    },
  };
}

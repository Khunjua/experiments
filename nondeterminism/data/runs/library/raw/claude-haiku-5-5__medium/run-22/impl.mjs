const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const PICKUP_DAYS = 3;
const GRACE_DAYS = 3;
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

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, dueDate, renewals} | null, holds: [{memberId, readyUntil}] }
  const members = new Map(); // memberId -> { owed }

  // The first hold in line becomes ready once the book is free.
  function promote(book, availableOn) {
    if (!book.loan && book.holds.length > 0) {
      book.holds[0].readyUntil = addDays(availableOn, PICKUP_DAYS);
    }
  }

  // Expire set-aside holds whose pickup window ended before `date`.
  function sync(date) {
    for (const book of books.values()) {
      while (!book.loan && book.holds.length > 0 && book.holds[0].readyUntil < date) {
        const expired = book.holds.shift().readyUntil;
        if (book.holds.length > 0) promote(book, addDays(expired, 1));
      }
    }
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, holds: [] });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      sync(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || book.loan) return { ok: false };
      if (book.holds.length > 0 && book.holds[0].memberId !== memberId) return { ok: false };
      if (book.holds.length > 0) book.holds.shift();
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      sync(date);
      const book = books.get(bookId);
      if (!book || !book.loan || book.loan.memberId !== memberId) return { ok: false, fine: 0 };
      const late = daysBetween(book.loan.dueDate, date) - GRACE_DAYS;
      const fine = late > 0 ? Math.min(late * FINE_PER_DAY, FINE_CAP) : 0;
      members.get(memberId).owed += fine;
      book.loan = null;
      promote(book, date);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      sync(date);
      const book = books.get(bookId);
      if (!book || !book.loan || book.loan.memberId !== memberId) return { ok: false };
      if (book.holds.length > 0) return { ok: false };
      if (book.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (date > book.loan.dueDate) return { ok: false };
      book.loan.dueDate = addDays(date, LOAN_DAYS);
      book.loan.renewals += 1;
      return { ok: true, dueDate: book.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      sync(date);
      const book = books.get(bookId);
      if (!members.has(memberId) || !book || !book.loan) return { ok: false };
      if (book.loan.memberId === memberId) return { ok: false };
      if (book.holds.some((h) => h.memberId === memberId)) return { ok: false };
      book.holds.push({ memberId, readyUntil: null });
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date }) {
      sync(date);
      const member = members.get(memberId);
      if (!member || !Number.isInteger(amount) || amount <= 0 || amount > member.owed) {
        return { ok: false };
      }
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date }) {
      sync(date);
      const member = members.get(memberId);
      const result = { loans: [], owed: member ? member.owed : 0, holds: [] };
      if (!member) return result;
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          result.loans.push({ bookId, dueDate: book.loan.dueDate });
        }
        book.holds.forEach((h, i) => {
          if (h.memberId === memberId) {
            result.holds.push({
              bookId,
              position: i + 1,
              readyUntil: i === 0 && !book.loan ? h.readyUntil : null,
            });
          }
        });
      }
      return result;
    },
  };
}

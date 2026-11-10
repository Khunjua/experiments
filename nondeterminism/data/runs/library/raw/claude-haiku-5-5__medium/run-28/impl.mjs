const DAY_MS = 24 * 60 * 60 * 1000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const PICKUP_DAYS = 7;

function toMs(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(date, n) {
  return new Date(toMs(date) + n * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(later, earlier) {
  return Math.round((toMs(later) - toMs(earlier)) / DAY_MS);
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null,
  //             queue: [memberId, ...] (waiting holds, in order),
  //             setAside: { memberId, readyUntil } | null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  // Expire set-asides whose pickup window ended before `date`.
  // The next waiting member gets a fresh 7-day window starting the day after expiry.
  function sweep(date) {
    for (const book of books.values()) {
      while (book.setAside && book.setAside.readyUntil < date) {
        const expired = book.setAside.readyUntil;
        book.setAside = null;
        if (!book.loan && book.queue.length > 0) {
          const memberId = book.queue.shift();
          book.setAside = { memberId, readyUntil: addDays(expired, PICKUP_DAYS) };
        }
      }
    }
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], setAside: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      if (!book || !members.has(memberId)) return { ok: false };
      if (book.loan) return { ok: false };
      if (book.setAside) {
        if (book.setAside.memberId !== memberId) return { ok: false };
        book.setAside = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      const member = members.get(memberId);
      if (!book || !member || !book.loan || book.loan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }
      const late = daysBetween(date, book.loan.dueDate);
      const chargeable = Math.max(0, late - GRACE_DAYS);
      const fine = Math.min(FINE_CAP, chargeable * FINE_PER_DAY);
      member.owed += fine;
      book.loan = null;
      if (book.queue.length > 0) {
        const next = book.queue.shift();
        book.setAside = {
          memberId: next,
          readyUntil: addDays(date, PICKUP_DAYS - 1),
        };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      if (!book || !members.has(memberId)) return { ok: false };
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return { ok: false };
      if (book.queue.length > 0) return { ok: false };
      if (loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (daysBetween(date, loan.dueDate) > 0) return { ok: false };
      loan.dueDate = addDays(date, LOAN_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      if (!book || !members.has(memberId)) return { ok: false };
      if (!book.loan || book.loan.memberId === memberId) return { ok: false };
      if (book.queue.includes(memberId)) return { ok: false };
      if (book.setAside && book.setAside.memberId === memberId) return { ok: false };
      book.queue.push(memberId);
      const position = (book.setAside ? 1 : 0) + book.queue.length;
      return { ok: true, position };
    },

    payFine({ memberId, amount, date }) {
      sweep(date);
      const member = members.get(memberId);
      if (!member) return { ok: false, owed: 0 };
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) {
        return { ok: false, owed: member.owed };
      }
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date }) {
      sweep(date);
      const member = members.get(memberId);
      if (!member) return { ok: false, loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: book.loan.dueDate });
        }
        if (book.setAside && book.setAside.memberId === memberId) {
          holds.push({ bookId, position: 1, readyUntil: book.setAside.readyUntil });
        } else {
          const i = book.queue.indexOf(memberId);
          if (i >= 0) {
            holds.push({
              bookId,
              position: (book.setAside ? 1 : 0) + i + 1,
              readyUntil: null,
            });
          }
        }
      }
      return { loans, owed: member.owed, holds };
    },
  };
}

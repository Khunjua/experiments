const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const RENEW_DAYS = 21;
const SET_ASIDE_DAYS = 3;
const MAX_LOANS = 5;
const MAX_RENEWALS = 2;
const BORROW_BLOCK_OWED = 1000;
const LATE_FREE_DAYS = 2;
const LATE_RATE = 25;
const FINE_CAP = 500;

function toDayNum(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function fromDayNum(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addDays(s, days) {
  return fromDayNum(toDayNum(s) + days);
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null,
  //             queue: [memberId, ...],   // holds in line; queue[0] is the set-aside holder when readyUntil !== null
  //             readyUntil: string | null }
  const books = new Map();
  // memberId -> { owed: number }
  const members = new Map();

  // Settle expired set-asides up to the given date.
  function advance(date) {
    const now = toDayNum(date);
    for (const book of books.values()) {
      while (book.readyUntil !== null && now > toDayNum(book.readyUntil)) {
        book.queue.shift();
        book.readyUntil = book.queue.length > 0
          ? addDays(book.readyUntil, SET_ASIDE_DAYS)
          : null;
      }
    }
  }

  function loanCount(memberId) {
    let n = 0;
    for (const book of books.values()) {
      if (book.loan && book.loan.memberId === memberId) n++;
    }
    return n;
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      advance(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return { ok: false };
      if (member.owed >= BORROW_BLOCK_OWED) return { ok: false, owed: member.owed };
      if (loanCount(memberId) >= MAX_LOANS) return { ok: false };
      if (book.loan) return { ok: false };
      if (book.readyUntil !== null && book.queue[0] !== memberId) return { ok: false };

      if (book.readyUntil !== null) {
        // The hold ends; everyone behind moves up automatically.
        book.queue.shift();
        book.readyUntil = null;
      }

      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      advance(date);
      const book = books.get(bookId);
      const member = members.get(memberId);
      if (!book || !member || !book.loan || book.loan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }

      const late = Math.max(0, toDayNum(date) - toDayNum(book.loan.dueDate));
      let fine = 0;
      if (late > LATE_FREE_DAYS) {
        fine = Math.min(late * LATE_RATE, FINE_CAP);
      }
      member.owed += fine;

      book.loan = null;
      if (book.queue.length > 0) {
        book.readyUntil = addDays(date, SET_ASIDE_DAYS);
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      advance(date);
      const book = books.get(bookId);
      if (!book || !book.loan || book.loan.memberId !== memberId) return { ok: false };
      if (book.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (book.queue.length > 0) return { ok: false };
      if (toDayNum(date) > toDayNum(book.loan.dueDate)) return { ok: false };

      book.loan.dueDate = addDays(book.loan.dueDate, RENEW_DAYS);
      book.loan.renewals += 1;
      return { ok: true, dueDate: book.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      advance(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return { ok: false };
      if (!book.loan && book.readyUntil === null) return { ok: false };
      if (book.loan && book.loan.memberId === memberId) return { ok: false };
      if (book.queue.includes(memberId)) return { ok: false };

      book.queue.push(memberId);
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date }) {
      advance(date);
      const member = members.get(memberId);
      if (!member) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) {
        return { ok: false, owed: member.owed };
      }
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date }) {
      advance(date);
      const member = members.get(memberId);
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: book.loan.dueDate });
        }
        const i = book.queue.indexOf(memberId);
        if (i !== -1) {
          holds.push({
            bookId,
            position: i + 1,
            readyUntil: i === 0 && book.readyUntil !== null ? book.readyUntil : null,
          });
        }
      }
      return { loans, owed: member ? member.owed : 0, holds };
    },
  };
}

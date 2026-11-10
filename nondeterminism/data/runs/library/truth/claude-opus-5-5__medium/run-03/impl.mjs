const DAY_MS = 86400000;

function toDay(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromDay(dayNum) {
  const dt = new Date(dayNum * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const OWED_LIMIT = 1000;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const PICKUP_DAYS = 3;

function fail(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDay, renewals } | null, holds: [memberId], setAside: { memberId, readyUntilDay } | null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  function advanceBook(book, today) {
    while (book.setAside && today > book.setAside.readyUntilDay) {
      const oldReady = book.setAside.readyUntilDay;
      // Drop the hold of the member the book was set aside for (always holds[0]).
      if (book.holds.length > 0 && book.holds[0] === book.setAside.memberId) {
        book.holds.shift();
      } else {
        book.holds = book.holds.filter((m) => m !== book.setAside.memberId);
      }
      if (book.holds.length > 0) {
        book.setAside = { memberId: book.holds[0], readyUntilDay: oldReady + PICKUP_DAYS };
      } else {
        book.setAside = null;
      }
    }
  }

  function advanceAll(today) {
    for (const book of books.values()) advanceBook(book, today);
  }

  function loanCount(memberId) {
    let n = 0;
    for (const book of books.values()) {
      if (book.loan && book.loan.memberId === memberId) n++;
    }
    return n;
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null) return fail('invalid bookId');
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { loan: null, holds: [], setAside: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null) return fail('invalid memberId');
      if (members.has(memberId)) return fail('member exists');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const today = toDay(date);
      advanceAll(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loan) return fail('book on loan');
      if (member.owed >= OWED_LIMIT) return fail('owes too much');
      if (loanCount(memberId) >= MAX_LOANS) return fail('too many loans');
      if (book.setAside && book.setAside.memberId !== memberId) return fail('set aside for another member');
      if (book.setAside) {
        book.holds = book.holds.filter((m) => m !== memberId);
        book.setAside = null;
      }
      const dueDay = today + LOAN_DAYS;
      book.loan = { memberId, dueDay, renewals: 0 };
      return { ok: true, dueDate: fromDay(dueDay) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const today = toDay(date);
      advanceAll(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return fail('not on loan to member', { fine: 0 });
      }
      const daysLate = today - book.loan.dueDay;
      let fine = 0;
      if (daysLate > GRACE_DAYS) fine = Math.min(daysLate * FINE_PER_DAY, FINE_CAP);
      member.owed += fine;
      book.loan = null;
      if (book.holds.length > 0) {
        book.setAside = { memberId: book.holds[0], readyUntilDay: today + PICKUP_DAYS };
      } else {
        book.setAside = null;
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const today = toDay(date);
      advanceAll(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return fail('not on loan to member');
      }
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (book.holds.length > 0) return fail('book has holds');
      if (today > book.loan.dueDay) return fail('overdue');
      book.loan.dueDay += LOAN_DAYS;
      book.loan.renewals += 1;
      return { ok: true, dueDate: fromDay(book.loan.dueDay) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const today = toDay(date);
      advanceAll(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan && !book.setAside) return fail('book is on the shelf');
      if (book.loan && book.loan.memberId === memberId) return fail('member has book on loan');
      if (book.holds.includes(memberId)) return fail('already holding');
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const today = toDay(date);
      advanceAll(today);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
        return fail('invalid amount', { owed: member.owed });
      }
      if (amount > member.owed) return fail('overpayment', { owed: member.owed });
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const today = toDay(date);
      advanceAll(today);
      const member = members.get(memberId);
      if (!member) return { ok: false, reason: 'unknown member', loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: fromDay(book.loan.dueDay) });
        }
        const idx = book.holds.indexOf(memberId);
        if (idx !== -1) {
          const readyUntil =
            book.setAside && book.setAside.memberId === memberId
              ? fromDay(book.setAside.readyUntilDay)
              : null;
          holds.push({ bookId, position: idx + 1, readyUntil });
        }
      }
      return { loans, owed: member.owed, holds };
    },
  };
}

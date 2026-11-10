const DAY_MS = 86400000;

function toDays(date) {
  return Math.round(Date.parse(date + 'T00:00:00Z') / DAY_MS);
}

function fromDays(days) {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

function addDays(date, n) {
  return fromDays(toDays(date) + n);
}

const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const OWED_LIMIT = 1000;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const PICKUP_DAYS = 3;

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null, queue: [memberId], setAside: { memberId, readyUntil } | null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  function advance(date) {
    if (typeof date !== 'string') return;
    for (const book of books.values()) {
      while (book.setAside && date > book.setAside.readyUntil) {
        const oldReady = book.setAside.readyUntil;
        book.queue.shift();
        if (book.queue.length > 0) {
          book.setAside = { memberId: book.queue[0], readyUntil: addDays(oldReady, PICKUP_DAYS) };
        } else {
          book.setAside = null;
        }
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

  function fail(reason) {
    return { ok: false, reason };
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid or duplicate book');
      books.set(bookId, { loan: null, queue: [], setAside: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid or duplicate member');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      advance(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loan) return fail('book on loan');
      if (book.setAside && book.setAside.memberId !== memberId) return fail('book set aside for another member');
      if (loanCount(memberId) >= MAX_LOANS) return fail('loan limit reached');
      if (member.owed >= OWED_LIMIT) return fail('owes too much');
      if (book.setAside && book.setAside.memberId === memberId) {
        book.queue.shift();
        book.setAside = null;
      } else {
        // Defensive: if the member is in the queue for some reason, remove them.
        const idx = book.queue.indexOf(memberId);
        if (idx >= 0) book.queue.splice(idx, 1);
      }
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      advance(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return fail('not on loan to this member');
      }
      const daysLate = toDays(date) - toDays(book.loan.dueDate);
      let fine = 0;
      if (daysLate > GRACE_DAYS) fine = Math.min(daysLate * FINE_PER_DAY, FINE_CAP);
      member.owed += fine;
      book.loan = null;
      if (book.queue.length > 0) {
        book.setAside = { memberId: book.queue[0], readyUntil: addDays(date, PICKUP_DAYS) };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      advance(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return fail('not on loan to this member');
      }
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (book.queue.length > 0) return fail('book has holds');
      if (date > book.loan.dueDate) return fail('loan overdue');
      book.loan.dueDate = addDays(book.loan.dueDate, LOAN_DAYS);
      book.loan.renewals++;
      return { ok: true, dueDate: book.loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      advance(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan && !book.setAside) return fail('book is on the shelf');
      if (book.loan && book.loan.memberId === memberId) return fail('member has the book on loan');
      if (book.queue.includes(memberId)) return fail('already holding');
      book.queue.push(memberId);
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      advance(date);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      advance(date);
      const member = members.get(memberId);
      if (!member) return { ok: false, reason: 'unknown member', loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: book.loan.dueDate });
        }
        const idx = book.queue.indexOf(memberId);
        if (idx >= 0) {
          const readyUntil =
            book.setAside && book.setAside.memberId === memberId ? book.setAside.readyUntil : null;
          holds.push({ bookId, position: idx + 1, readyUntil });
        }
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}

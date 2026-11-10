const DAY_MS = 86400000;

function toDays(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromDays(days) {
  const dt = new Date(days * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(dateStr, n) {
  return fromDays(toDays(dateStr) + n);
}

const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const OWED_LIMIT = 1000;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_PICKUP_DAYS = 3;

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null, queue: [memberId], setAside: { memberId, readyUntil } | null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  function fail(reason) {
    return { ok: false, reason };
  }

  function advance(date) {
    if (typeof date !== 'string') return;
    const today = toDays(date);
    for (const book of books.values()) {
      while (book.setAside && today > toDays(book.setAside.readyUntil)) {
        const oldUntil = book.setAside.readyUntil;
        const idx = book.queue.indexOf(book.setAside.memberId);
        if (idx !== -1) book.queue.splice(idx, 1);
        if (book.queue.length > 0) {
          book.setAside = {
            memberId: book.queue[0],
            readyUntil: addDays(oldUntil, HOLD_PICKUP_DAYS),
          };
        } else {
          book.setAside = null;
        }
      }
    }
  }

  function loansOf(memberId) {
    const out = [];
    for (const [bookId, book] of books) {
      if (book.loan && book.loan.memberId === memberId) out.push({ bookId, book });
    }
    return out;
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null) return fail('invalid bookId');
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { loan: null, queue: [], setAside: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null) return fail('invalid memberId');
      if (members.has(memberId)) return fail('member exists');
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
      if (book.setAside && book.setAside.memberId !== memberId) return fail('set aside for another member');
      if (member.owed >= OWED_LIMIT) return fail('owes too much');
      if (loansOf(memberId).length >= MAX_LOANS) return fail('too many loans');
      if (book.setAside) {
        const idx = book.queue.indexOf(memberId);
        if (idx !== -1) book.queue.splice(idx, 1);
        book.setAside = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      advance(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      const late = toDays(date) - toDays(book.loan.dueDate);
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      member.owed += fine;
      book.loan = null;
      if (book.queue.length > 0) {
        book.setAside = {
          memberId: book.queue[0],
          readyUntil: addDays(date, HOLD_PICKUP_DAYS),
        };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      advance(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (book.queue.length > 0) return fail('book has holds');
      if (toDays(date) > toDays(book.loan.dueDate)) return fail('overdue');
      book.loan.dueDate = addDays(book.loan.dueDate, LOAN_DAYS);
      book.loan.renewals += 1;
      return { ok: true, dueDate: book.loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      advance(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan && !book.setAside) return fail('book is on the shelf');
      if (book.loan && book.loan.memberId === memberId) return fail('member has book on loan');
      if (book.queue.includes(memberId)) return fail('already holding');
      book.queue.push(memberId);
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      advance(date);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (typeof amount !== 'number' || !Number.isInteger(amount)) return fail('invalid amount');
      if (amount <= 0) return fail('amount must be positive');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      advance(date);
      const member = members.get(memberId);
      if (!member) return { ok: false, reason: 'unknown member', loans: [], owed: 0, holds: [] };
      const loans = loansOf(memberId).map(({ bookId, book }) => ({
        bookId,
        dueDate: book.loan.dueDate,
      }));
      const holds = [];
      for (const [bookId, book] of books) {
        const idx = book.queue.indexOf(memberId);
        if (idx === -1) continue;
        const readyUntil =
          book.setAside && book.setAside.memberId === memberId ? book.setAside.readyUntil : null;
        holds.push({ bookId, position: idx + 1, readyUntil });
      }
      return { loans, owed: member.owed, holds };
    },
  };
}

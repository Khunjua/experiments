const DAY_MS = 86400000;

function toDays(dateStr) {
  if (typeof dateStr !== 'string') return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return NaN;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS);
}

function fromDays(days) {
  const d = new Date(days * DAY_MS);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
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
  // memberId -> { owed, loans: Set<bookId> }
  const members = new Map();

  function fail(reason) {
    return { ok: false, reason };
  }

  function processExpiry(date) {
    const today = toDays(date);
    if (Number.isNaN(today)) return;
    for (const book of books.values()) {
      while (book.setAside && today > toDays(book.setAside.readyUntil)) {
        const { memberId, readyUntil } = book.setAside;
        const idx = book.queue.indexOf(memberId);
        if (idx !== -1) book.queue.splice(idx, 1);
        if (book.queue.length > 0) {
          book.setAside = { memberId: book.queue[0], readyUntil: addDays(readyUntil, HOLD_PICKUP_DAYS) };
        } else {
          book.setAside = null;
        }
      }
    }
  }

  function validDate(date) {
    return !Number.isNaN(toDays(date));
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
      members.set(memberId, { owed: 0, loans: new Set() });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('invalid date');
      processExpiry(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (member.owed >= OWED_LIMIT) return fail('owes too much');
      if (member.loans.size >= MAX_LOANS) return fail('too many loans');
      if (book.loan) return fail('book on loan');
      if (book.setAside && book.setAside.memberId !== memberId) return fail('book set aside for another member');
      if (book.setAside) {
        const idx = book.queue.indexOf(memberId);
        if (idx !== -1) book.queue.splice(idx, 1);
        book.setAside = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      member.loans.add(bookId);
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('invalid date');
      processExpiry(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      const late = toDays(date) - toDays(book.loan.dueDate);
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      member.owed += fine;
      member.loans.delete(bookId);
      book.loan = null;
      if (book.queue.length > 0) {
        book.setAside = { memberId: book.queue[0], readyUntil: addDays(date, HOLD_PICKUP_DAYS) };
      } else {
        book.setAside = null;
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('invalid date');
      processExpiry(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (book.queue.length > 0) return fail('book has holds');
      if (toDays(date) > toDays(book.loan.dueDate)) return fail('overdue');
      book.loan.dueDate = addDays(book.loan.dueDate, LOAN_DAYS);
      book.loan.renewals += 1;
      return { ok: true, dueDate: book.loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('invalid date');
      processExpiry(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (!book.loan && !book.setAside) return fail('book is on the shelf');
      if (book.loan && book.loan.memberId === memberId) return fail('member has book on loan');
      if (book.queue.includes(memberId)) return fail('already holding');
      book.queue.push(memberId);
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      if (validDate(date)) processExpiry(date);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      if (validDate(date)) processExpiry(date);
      const member = members.get(memberId);
      if (!member) return { ok: false, reason: 'unknown member', loans: [], owed: 0, holds: [] };
      const loans = [];
      for (const bookId of member.loans) {
        loans.push({ bookId, dueDate: books.get(bookId).loan.dueDate });
      }
      const holds = [];
      for (const [bookId, book] of books) {
        const idx = book.queue.indexOf(memberId);
        if (idx === -1) continue;
        const readyUntil = book.setAside && book.setAside.memberId === memberId ? book.setAside.readyUntil : null;
        holds.push({ bookId, position: idx + 1, readyUntil });
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}

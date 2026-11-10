const DAY_MS = 24 * 60 * 60 * 1000;

function toDays(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromDays(days) {
  const dt = new Date(days * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date, n) {
  return fromDays(toDays(date) + n);
}

function isValidDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return fromDays(toDays(date)) === date;
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
  const books = new Map();   // bookId -> { loan, holds, setAside }
  const members = new Map(); // memberId -> { owed }

  function refuse(reason) {
    return { ok: false, reason };
  }

  function processExpiries(date) {
    if (!isValidDate(date)) return;
    const today = toDays(date);
    for (const book of books.values()) {
      while (book.setAside && today > toDays(book.setAside.readyUntil)) {
        const oldReadyUntil = book.setAside.readyUntil;
        const idx = book.holds.indexOf(book.setAside.memberId);
        if (idx !== -1) book.holds.splice(idx, 1);
        if (book.holds.length > 0) {
          book.setAside = {
            memberId: book.holds[0],
            readyUntil: addDays(oldReadyUntil, HOLD_PICKUP_DAYS),
          };
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

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null) return refuse('invalid bookId');
      if (books.has(bookId)) return refuse('book exists');
      books.set(bookId, { loan: null, holds: [], setAside: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null) return refuse('invalid memberId');
      if (members.has(memberId)) return refuse('member exists');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return refuse('invalid date');
      processExpiries(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return refuse('unknown member');
      if (!book) return refuse('unknown book');
      if (book.loan) return refuse('book on loan');
      if (book.setAside && book.setAside.memberId !== memberId) return refuse('set aside for another member');
      if (member.owed >= OWED_LIMIT) return refuse('owes too much');
      if (loanCount(memberId) >= MAX_LOANS) return refuse('loan limit reached');

      if (book.setAside && book.setAside.memberId === memberId) {
        const idx = book.holds.indexOf(memberId);
        if (idx !== -1) book.holds.splice(idx, 1);
        book.setAside = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return refuse('invalid date');
      processExpiries(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return refuse('not on loan to member');
      }
      const daysLate = toDays(date) - toDays(book.loan.dueDate);
      let fine = 0;
      if (daysLate > GRACE_DAYS) fine = Math.min(daysLate * FINE_PER_DAY, FINE_CAP);
      member.owed += fine;
      book.loan = null;
      if (book.holds.length > 0) {
        book.setAside = {
          memberId: book.holds[0],
          readyUntil: addDays(date, HOLD_PICKUP_DAYS),
        };
      } else {
        book.setAside = null;
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return refuse('invalid date');
      processExpiries(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return refuse('not on loan to member');
      }
      if (book.loan.renewals >= MAX_RENEWALS) return refuse('renewal limit reached');
      if (book.holds.length > 0) return refuse('book has holds');
      if (toDays(date) > toDays(book.loan.dueDate)) return refuse('overdue');
      book.loan.dueDate = addDays(book.loan.dueDate, LOAN_DAYS);
      book.loan.renewals += 1;
      return { ok: true, dueDate: book.loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return refuse('invalid date');
      processExpiries(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return refuse('unknown member');
      if (!book) return refuse('unknown book');
      if (!book.loan && !book.setAside) return refuse('book is on the shelf');
      if (book.loan && book.loan.memberId === memberId) return refuse('member has book on loan');
      if (book.holds.includes(memberId)) return refuse('already holding');
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      if (isValidDate(date)) processExpiries(date);
      const member = members.get(memberId);
      if (!member) return refuse('unknown member');
      if (typeof amount !== 'number' || !Number.isInteger(amount)) return refuse('invalid amount');
      if (amount <= 0) return refuse('non-positive amount');
      if (amount > member.owed) return refuse('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      if (isValidDate(date)) processExpiries(date);
      const member = members.get(memberId);
      if (!member) return { ok: false, reason: 'unknown member', loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: book.loan.dueDate });
        }
        const idx = book.holds.indexOf(memberId);
        if (idx !== -1) {
          const readyUntil =
            book.setAside && book.setAside.memberId === memberId ? book.setAside.readyUntil : null;
          holds.push({ bookId, position: idx + 1, readyUntil });
        }
      }
      return { loans, owed: member.owed, holds };
    },
  };
}

const DAY_MS = 86400000;

function toDays(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromDays(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fromDays(toDays(s) + n);
}

const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const OWED_LIMIT = 1000;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_DAYS = 3;

export function createLibrary() {
  // bookId -> { loan: {memberId, dueDate, renewals} | null, holds: [memberId], setAside: {memberId, until} | null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  function advance(date) {
    if (typeof date !== 'string') return;
    const today = toDays(date);
    for (const book of books.values()) {
      while (book.setAside && today > toDays(book.setAside.until)) {
        const oldUntil = book.setAside.until;
        const who = book.setAside.memberId;
        const idx = book.holds.indexOf(who);
        if (idx >= 0) book.holds.splice(idx, 1);
        if (book.holds.length > 0) {
          book.setAside = { memberId: book.holds[0], until: addDays(oldUntil, HOLD_DAYS) };
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
      if (bookId === undefined || bookId === null || books.has(bookId)) {
        return { ok: false, reason: 'invalid or duplicate book' };
      }
      books.set(bookId, { loan: null, holds: [], setAside: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) {
        return { ok: false, reason: 'invalid or duplicate member' };
      }
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      advance(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return { ok: false, reason: 'unknown member or book' };
      if (book.loan) return { ok: false, reason: 'book on loan' };
      if (book.setAside && book.setAside.memberId !== memberId) {
        return { ok: false, reason: 'book set aside for another member' };
      }
      if (member.owed >= OWED_LIMIT) return { ok: false, reason: 'owes too much' };
      if (loansOf(memberId).length >= MAX_LOANS) return { ok: false, reason: 'loan limit' };
      if (book.setAside) {
        const idx = book.holds.indexOf(memberId);
        if (idx >= 0) book.holds.splice(idx, 1);
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
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return { ok: false, reason: 'not on loan to member' };
      }
      const late = toDays(date) - toDays(book.loan.dueDate);
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      member.owed += fine;
      book.loan = null;
      if (book.holds.length > 0) {
        book.setAside = { memberId: book.holds[0], until: addDays(date, HOLD_DAYS) };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      advance(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return { ok: false, reason: 'not on loan to member' };
      }
      if (book.loan.renewals >= MAX_RENEWALS) return { ok: false, reason: 'renewal limit' };
      if (book.holds.length > 0) return { ok: false, reason: 'book has holds' };
      if (toDays(date) > toDays(book.loan.dueDate)) return { ok: false, reason: 'overdue' };
      book.loan.dueDate = addDays(book.loan.dueDate, LOAN_DAYS);
      book.loan.renewals += 1;
      return { ok: true, dueDate: book.loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      advance(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return { ok: false, reason: 'unknown member or book' };
      if (!book.loan && !book.setAside) return { ok: false, reason: 'book is on the shelf' };
      if (book.loan && book.loan.memberId === memberId) {
        return { ok: false, reason: 'member has book on loan' };
      }
      if (book.holds.includes(memberId)) return { ok: false, reason: 'duplicate hold' };
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      advance(date);
      const member = members.get(memberId);
      if (!member) return { ok: false, reason: 'unknown member' };
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0 || amount > member.owed) {
        return { ok: false, reason: 'invalid amount' };
      }
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      advance(date);
      const member = members.get(memberId);
      if (!member) return { ok: false, reason: 'unknown member', loans: [], owed: 0, holds: [] };
      const loans = loansOf(memberId).map(({ bookId, book }) => ({ bookId, dueDate: book.loan.dueDate }));
      const holds = [];
      for (const [bookId, book] of books) {
        const idx = book.holds.indexOf(memberId);
        if (idx >= 0) {
          const readyUntil =
            book.setAside && book.setAside.memberId === memberId ? book.setAside.until : null;
          holds.push({ bookId, position: idx + 1, readyUntil });
        }
      }
      return { loans, owed: member.owed, holds };
    },
  };
}

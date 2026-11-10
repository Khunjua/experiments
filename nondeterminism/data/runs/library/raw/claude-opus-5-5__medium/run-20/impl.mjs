const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const DAILY_FINE = 25;
const GRACE_DAYS = 2;
const MAX_FINE_PER_LOAN = 500;
const BORROW_BLOCK_OWED = 500;
const HOLD_PICKUP_DAYS = 7;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toDay(date) {
  if (typeof date !== 'string') return null;
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / 86400000);
}

function fromDay(day) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

function validId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

const FAIL = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, dueDay, renewals} | null, holds: [{memberId, readyUntil}] }
  const members = new Map(); // memberId -> { owed, loans: Set<bookId> }

  // Process hold expirations up to and including `today`.
  function processHolds(today) {
    for (const book of books.values()) {
      while (book.holds.length > 0) {
        const first = book.holds[0];
        if (first.readyUntil === null || today <= first.readyUntil) break;
        const expired = first.readyUntil;
        book.holds.shift();
        if (book.holds.length > 0) {
          book.holds[0].readyUntil = expired + HOLD_PICKUP_DAYS;
        }
      }
    }
  }

  function prep(memberId, bookId, date, needBook = true) {
    const today = toDay(date);
    if (today === null) return { err: FAIL('invalid date') };
    const member = members.get(memberId);
    if (!member) return { err: FAIL('unknown member') };
    let book = null;
    if (needBook) {
      book = books.get(bookId);
      if (!book) return { err: FAIL('unknown book') };
    }
    processHolds(today);
    return { today, member, book };
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId) || books.has(bookId)) return FAIL('invalid or duplicate book');
      books.set(bookId, { loan: null, holds: [] });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId) || members.has(memberId)) return FAIL('invalid or duplicate member');
      members.set(memberId, { owed: 0, loans: new Set() });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const p = prep(memberId, bookId, date);
      if (p.err) return p.err;
      const { today, member, book } = p;
      if (book.loan) return FAIL('book is on loan');
      if (book.holds.length > 0) {
        const first = book.holds[0];
        if (first.memberId !== memberId || first.readyUntil === null) return FAIL('book is set aside for another member');
      }
      if (member.loans.size >= MAX_LOANS) return FAIL('loan limit reached');
      if (member.owed >= BORROW_BLOCK_OWED) return FAIL('too much owed');
      if (book.holds.length > 0) book.holds.shift();
      const dueDay = today + LOAN_DAYS;
      book.loan = { memberId, dueDay, renewals: 0 };
      member.loans.add(bookId);
      return { ok: true, dueDate: fromDay(dueDay) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const p = prep(memberId, bookId, date);
      if (p.err) return p.err;
      const { today, member, book } = p;
      if (!book.loan || book.loan.memberId !== memberId) return FAIL('not on loan to this member');
      const late = today - book.loan.dueDay;
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * DAILY_FINE, MAX_FINE_PER_LOAN);
      member.owed += fine;
      member.loans.delete(bookId);
      book.loan = null;
      if (book.holds.length > 0) book.holds[0].readyUntil = today + HOLD_PICKUP_DAYS;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const p = prep(memberId, bookId, date);
      if (p.err) return p.err;
      const { today, book } = p;
      if (!book.loan || book.loan.memberId !== memberId) return FAIL('not on loan to this member');
      if (book.holds.length > 0) return FAIL('others are waiting');
      if (book.loan.renewals >= MAX_RENEWALS) return FAIL('renewal limit reached');
      if (today > book.loan.dueDay) return FAIL('overdue');
      const newDue = Math.max(book.loan.dueDay, today + LOAN_DAYS);
      book.loan.dueDay = newDue;
      book.loan.renewals += 1;
      return { ok: true, dueDate: fromDay(newDue) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const p = prep(memberId, bookId, date);
      if (p.err) return p.err;
      const { book } = p;
      if (!book.loan && book.holds.length === 0) return FAIL('book is available');
      if (book.loan && book.loan.memberId === memberId) return FAIL('member has this book');
      if (book.holds.some((h) => h.memberId === memberId)) return FAIL('already holding');
      book.holds.push({ memberId, readyUntil: null });
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const p = prep(memberId, null, date, false);
      if (p.err) return p.err;
      const { member } = p;
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) return FAIL('invalid amount');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const p = prep(memberId, null, date, false);
      if (p.err) return p.err;
      const { member } = p;
      const loans = [];
      for (const bookId of member.loans) {
        loans.push({ bookId, dueDate: fromDay(books.get(bookId).loan.dueDay) });
      }
      const holds = [];
      for (const [bookId, book] of books) {
        const idx = book.holds.findIndex((h) => h.memberId === memberId);
        if (idx >= 0) {
          const h = book.holds[idx];
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: idx === 0 && h.readyUntil !== null ? fromDay(h.readyUntil) : null,
          });
        }
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}

const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const BORROW_BLOCK_OWED = 1000;
const PICKUP_DAYS = 7;

function toMs(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const [y, m, day] = d.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, day);
  const back = new Date(ms).toISOString().slice(0, 10);
  return back === d ? ms : null;
}

function fromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(d, n) {
  return fromMs(toMs(d) + n * DAY_MS);
}

function daysBetween(a, b) {
  return Math.round((toMs(b) - toMs(a)) / DAY_MS);
}

function validId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let loanSeq = 0;

  function fail(reason) {
    return { ok: false, reason };
  }

  function advance(date) {
    for (const book of books.values()) {
      if (book.loan || book.holds.length === 0 || book.readyUntil === null) continue;
      while (book.holds.length > 0 && book.readyUntil < date) {
        book.holds.shift();
        if (book.holds.length > 0) {
          const start = addDays(book.readyUntil, 1);
          book.readyUntil = addDays(start, PICKUP_DAYS);
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  function checkDate(date) {
    return toMs(date) !== null;
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('duplicate book');
      books.set(bookId, { loan: null, holds: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('duplicate member');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      if (!checkDate(date)) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      advance(date);
      if (book.loan) return fail('book on loan');
      if (member.owed >= BORROW_BLOCK_OWED) return fail('too much owed');
      if (book.holds.length > 0) {
        if (book.holds[0] !== memberId) return fail('book set aside for another member');
        book.holds.shift();
        book.readyUntil = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0, seq: loanSeq++ };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      if (!checkDate(date)) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      advance(date);
      if (!book.loan || book.loan.memberId !== memberId) return fail('not borrowed by member');
      const late = Math.max(0, daysBetween(book.loan.dueDate, date));
      const fine = Math.min(late * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      member.owed += fine;
      book.loan = null;
      book.readyUntil = book.holds.length > 0 ? addDays(date, PICKUP_DAYS) : null;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      if (!checkDate(date)) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      advance(date);
      if (!book.loan || book.loan.memberId !== memberId) return fail('not borrowed by member');
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (book.holds.length > 0) return fail('others waiting');
      if (date > book.loan.dueDate) return fail('overdue');
      const newDue = addDays(date, LOAN_DAYS);
      const dueDate = newDue > book.loan.dueDate ? newDue : book.loan.dueDate;
      book.loan.dueDate = dueDate;
      book.loan.renewals += 1;
      return { ok: true, dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      if (!checkDate(date)) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      advance(date);
      if (!book.loan && book.holds.length === 0) return fail('book is available');
      if (book.loan && book.loan.memberId === memberId) return fail('member has the book');
      if (book.holds.includes(memberId)) return fail('already holding');
      book.holds.push(memberId);
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      if (!checkDate(date)) return fail('invalid date');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      advance(date);
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const member = members.get(memberId);
      if (!member || !checkDate(date)) {
        return { ok: false, reason: 'unknown member or invalid date', loans: [], owed: 0, holds: [] };
      }
      advance(date);
      const loanList = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loanList.push({ bookId, dueDate: book.loan.dueDate, seq: book.loan.seq });
        }
        const idx = book.holds.indexOf(memberId);
        if (idx !== -1) {
          const setAside = idx === 0 && !book.loan && book.readyUntil !== null;
          holds.push({ bookId, position: idx + 1, readyUntil: setAside ? book.readyUntil : null });
        }
      }
      loanList.sort((a, b) => a.seq - b.seq);
      return {
        ok: true,
        loans: loanList.map(({ bookId, dueDate }) => ({ bookId, dueDate })),
        owed: member.owed,
        holds,
      };
    },
  };
}

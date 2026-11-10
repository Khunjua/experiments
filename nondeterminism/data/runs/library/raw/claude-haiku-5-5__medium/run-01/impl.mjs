const LOAN_DAYS = 21;
const RENEWAL_DAYS = 21;
const MAX_RENEWALS = 2;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const PICKUP_DAYS = 7;

function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const ms = new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z');
  return Math.round(ms / 86400000);
}

function removeItem(arr, item) {
  const i = arr.indexOf(item);
  if (i >= 0) arr.splice(i, 1);
}

export function createLibrary() {
  // bookId -> { id, loan: {memberId, dueDate, renewals} | null,
  //             queue: [memberId], readyFor: {memberId, readyUntil} | null }
  const books = new Map();
  // memberId -> { id, owed, loans: [bookId], holds: [bookId] }
  const members = new Map();

  // Lazily expire set-aside books whose pickup window ended before `date`.
  function settle(date) {
    for (const book of books.values()) {
      while (book.readyFor && book.readyFor.readyUntil < date) {
        const until = book.readyFor.readyUntil;
        const expiredId = book.queue.shift();
        removeItem(members.get(expiredId).holds, book.id);
        if (book.queue.length === 0) {
          book.readyFor = null;
          break;
        }
        book.readyFor = {
          memberId: book.queue[0],
          readyUntil: addDays(until, PICKUP_DAYS),
        };
      }
    }
  }

  // Set a returned book aside for the first waiting member, if any.
  function setAside(book, date) {
    if (!book.loan && book.queue.length > 0 && !book.readyFor) {
      book.readyFor = {
        memberId: book.queue[0],
        readyUntil: addDays(date, PICKUP_DAYS),
      };
    }
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { id: bookId, loan: null, queue: [], readyFor: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { id: memberId, owed: 0, loans: [], holds: [] });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      settle(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || b.loan) return { ok: false };
      if (b.readyFor && b.readyFor.memberId !== memberId) return { ok: false };
      if (b.readyFor) {
        b.queue.shift();
        removeItem(m.holds, bookId);
        b.readyFor = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      settle(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      const late = daysBetween(b.loan.dueDate, date);
      const chargeableDays = Math.max(0, late - GRACE_DAYS);
      const fine = Math.min(chargeableDays * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      m.owed += fine;
      removeItem(m.loans, bookId);
      b.loan = null;
      setAside(b, date);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      settle(date);
      const b = books.get(bookId);
      const m = members.get(memberId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (date > b.loan.dueDate) return { ok: false };
      b.loan.dueDate = addDays(date, RENEWAL_DAYS);
      b.loan.renewals += 1;
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      settle(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (m.holds.includes(bookId)) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      // Only books that are out or set aside for someone else can be held.
      if (!b.loan && !b.readyFor) return { ok: false };
      b.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      settle(date);
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      settle(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = m.loans.map((bookId) => ({
        bookId,
        dueDate: books.get(bookId).loan.dueDate,
      }));
      const holds = m.holds.map((bookId) => {
        const b = books.get(bookId);
        const position = b.queue.indexOf(memberId) + 1;
        const readyUntil =
          b.readyFor && b.readyFor.memberId === memberId
            ? b.readyFor.readyUntil
            : null;
        return { bookId, position, readyUntil };
      });
      return { loans, owed: m.owed, holds };
    },
  };
}

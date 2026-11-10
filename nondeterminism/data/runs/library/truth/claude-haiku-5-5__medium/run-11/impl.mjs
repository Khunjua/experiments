const DAY_MS = 86400000;

function toDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function toStr(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function validId(id) {
  return typeof id === 'string' && id.length > 0;
}

export function createLibrary() {
  // book: { loan: null | { memberId, dueDay, renewals },
  //         queue: [memberId, ...]  (position 1 = queue[0]),
  //         reservation: null | { memberId, readyDay } }
  // member: { loans: Set<bookId>, owed: cents }
  const books = new Map();
  const members = new Map();

  // Lapse set-aside books whose readyUntil is before today; pass the book on in line.
  function settle(today) {
    for (const book of books.values()) {
      while (book.reservation && book.reservation.readyDay < today) {
        book.queue.shift();
        book.reservation = book.queue.length
          ? { memberId: book.queue[0], readyDay: book.reservation.readyDay + 3 }
          : null;
      }
    }
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId) || books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], reservation: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId) || members.has(memberId)) return { ok: false };
      members.set(memberId, { loans: new Set(), owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const today = toDay(date);
      settle(today);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.loan) return { ok: false };
      if (m.loans.size >= 5) return { ok: false };
      if (m.owed >= 1000) return { ok: false };
      if (b.reservation && b.reservation.memberId !== memberId) return { ok: false };

      if (b.reservation) {
        // Borrowing the set-aside book ends this member's hold.
        b.queue.shift();
        b.reservation = null;
      }
      b.loan = { memberId, dueDay: today + 21, renewals: 0 };
      m.loans.add(bookId);
      return { ok: true, dueDate: toStr(today + 21) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const today = toDay(date);
      settle(today);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }

      const daysLate = today - b.loan.dueDay;
      const fine = daysLate >= 3 ? Math.min(daysLate * 25, 500) : 0;

      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;

      if (b.queue.length > 0) {
        b.reservation = { memberId: b.queue[0], readyDay: today + 3 };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const today = toDay(date);
      settle(today);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.loan.renewals >= 2) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (today > b.loan.dueDay) return { ok: false };

      b.loan.dueDay += 21;
      b.loan.renewals += 1;
      return { ok: true, dueDate: toStr(b.loan.dueDay) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const today = toDay(date);
      settle(today);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (!b.loan && !b.reservation) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };

      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      settle(toDay(date));
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false };

      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date } = {}) {
      settle(toDay(date));
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };

      const loans = [...m.loans].map((bookId) => ({
        bookId,
        dueDate: toStr(books.get(bookId).loan.dueDay),
      }));

      const holds = [];
      for (const [bookId, b] of books) {
        const idx = b.queue.indexOf(memberId);
        if (idx >= 0) {
          const setAside = b.reservation && b.reservation.memberId === memberId;
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: setAside ? toStr(b.reservation.readyDay) : null,
          });
        }
      }

      return { loans, owed: m.owed, holds };
    },
  };
}

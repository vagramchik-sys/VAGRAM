'use strict';

function createRepository({ db = null } = {}) {
  return {
    db,
    async read() {
      return { module: "developer-example", status: 'ok', items: [] };
    }
  };
}

module.exports = { createRepository };

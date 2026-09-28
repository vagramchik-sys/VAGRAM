'use strict';

const { createRepository } = require('./repository.cjs');

function createService({ repository = createRepository() } = {}) {
  return {
    async getStatus() {
      return repository.read();
    }
  };
}

module.exports = { createService };

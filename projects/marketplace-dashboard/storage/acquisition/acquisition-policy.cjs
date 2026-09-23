'use strict';
// Heavy acquisition is started only by an explicit owner request.
const ON_DEMAND = new Set(['market', 'insights-full', 'insights-funnel']);
const isOnDemand = kind => ON_DEMAND.has(kind);
module.exports = { isOnDemand };

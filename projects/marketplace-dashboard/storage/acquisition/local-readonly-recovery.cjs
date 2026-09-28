'use strict';

// The desktop runtime and PostgreSQL run on this machine. Never infer that a
// producer stopped from elapsed time, a missing receipt, or a released DB lease.
function processStopped(runnerId, probe = process.kill) {
  const match = /^runtime-([1-9][0-9]*)$/u.exec(runnerId || '');
  if (!match || !Number.isSafeInteger(Number(match[1]))) return false;
  try { probe(Number(match[1]), 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}

function createLocalReadonlyRecovery({ scheduler, repository, runnerId, probe = process.kill }) {
  return async (job, { finishedHere = false } = {}) => {
    if (!['insights-today', 'insights-full'].includes(job.kind)) return null;
    const owner = await scheduler.attemptOwner(job);
    // A reused PID or an inaccessible process fails closed. For this process,
    // only an acquisition promise actually awaited by this runner is eligible.
    const stopped = owner === runnerId ? finishedHere : processStopped(owner, probe);
    if (!stopped) return null;
    return repository.settleStoppedCommand({
      storeId: job.storeId, domain: 'insights', commandId: job.attemptId, producerStopped: true
    });
  };
}

module.exports = { createLocalReadonlyRecovery, processStopped };

'use strict';

// The desktop runtime and PostgreSQL run on this machine. Never infer that a
// producer stopped from elapsed time, a missing receipt, or a released DB lease.
function processStopped(runnerId, probe = process.kill) {
  const match = /^runtime-([1-9][0-9]*)$/u.exec(runnerId || '');
  if (!match || !Number.isSafeInteger(Number(match[1]))) return false;
  try { probe(Number(match[1]), 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}

const LIVE_DOMAINS = Object.freeze({'insights-today':'insights','insights-full':'insights',market:'market'});
const READONLY_SETTLE_KINDS = Object.freeze([...Object.keys(LIVE_DOMAINS), 'ozon-performance']);
function createLocalReadonlyRecovery({ scheduler, repository, performanceRepository = null, runnerId, probe = process.kill }) {
  return async (job, { finishedHere = false } = {}) => {
    if (!READONLY_SETTLE_KINDS.includes(job.kind)) return null;
    const owner = await scheduler.attemptOwner(job);
    // A reused PID or an inaccessible process fails closed. For this process,
    // only an acquisition promise actually awaited by this runner is eligible.
    const stopped = owner === runnerId ? finishedHere : processStopped(owner, probe);
    if (!stopped) return null;
    if (job.kind === 'ozon-performance') {
      if (typeof performanceRepository?.settleStoppedRefresh !== 'function') return null;
      return performanceRepository.settleStoppedRefresh({storeId:job.storeId,commandId:job.attemptId,expectedRevision:String(job.documentRevision ?? '0'),producerStopped:true});
    }
    return repository.settleStoppedCommand({
      storeId: job.storeId, domain: LIVE_DOMAINS[job.kind], commandId: job.attemptId, producerStopped: true
    });
  };
}

module.exports = { createLocalReadonlyRecovery, processStopped, READONLY_SETTLE_KINDS };

'use strict';
const INTERVAL=30*60*1000;
const ORDERS_INTERVAL=5*60*1000;
function lastAttempt({job,attemptAt,snapshotAt}){return Math.max(Date.parse(job?.startedAt)||0,Date.parse(attemptAt)||0)||(Date.parse(snapshotAt)||0)}
function due(state,now=Date.now(),interval=INTERVAL){return state.job?.status!=='running'&&now-lastAttempt(state)>=interval}
function nextAt(state,now=Date.now(),interval=INTERVAL){return new Date(Math.max(now,lastAttempt(state)+interval)).toISOString()}
module.exports={INTERVAL,ORDERS_INTERVAL,due,nextAt};

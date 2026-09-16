'use strict';
const INTERVAL=30*60*1000;
function lastAttempt({job,attemptAt,snapshotAt}){return Math.max(Date.parse(job?.startedAt)||0,Date.parse(attemptAt)||0)||(Date.parse(snapshotAt)||0)}
function due(state,now=Date.now()){return state.job?.status!=='running'&&now-lastAttempt(state)>=INTERVAL}
function nextAt(state,now=Date.now()){return new Date(Math.max(now,lastAttempt(state)+INTERVAL)).toISOString()}
module.exports={INTERVAL,due,nextAt};

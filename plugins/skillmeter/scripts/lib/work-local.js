"use strict";
// Experimental selected-task capture. This module has no network sender and
// writes outside the production queue. It never discovers transcript history.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const queue = require("./transcript-delta");
const {sessionMetadata} = require("./session-metadata");
const {retireDirectory} = require("./queue-retention");
const TTL_MS = 86400000;

function sourceMetadata(source) {
  const fd = fs.openSync(source,"r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw Error("unsupported-work-source");
    // Read only the bounded first record when checking identity. Never print it.
    const buffer = Buffer.alloc(1024 * 1024);
    const size = fs.readSync(fd,buffer,0,buffer.length,0), end = buffer.subarray(0,size).indexOf(10);
    if (end < 0) throw Error("unsupported-work-source");
    const record = sessionMetadata(JSON.parse(buffer.subarray(0,end).toString("utf8")));
    if (!record) throw Error("unsupported-work-source");
    return {...record.payload,fileId:`${stat.dev}:${stat.ino}`};
  } finally { fs.closeSync(fd); }
}
function isWorkSource(source) {
  try { return sourceMetadata(source).originator === "codex_work_desktop"; } catch { return false; }
}
function createWorkCapture({root,identity,now = Date.now}) {
  const policyFile = path.join(root,"selected.json"), chunks = path.join(root,"chunks");
  const read = () => {
    if (!fs.existsSync(policyFile)) return null;
    const policy = JSON.parse(fs.readFileSync(policyFile,"utf8"));
    if (policy.version !== 1 || !/^[a-f0-9]{64}$/.test(policy.queueId) ||
        !path.isAbsolute(policy.source || "") || !policy.scope?.sessionId || !policy.scope?.consentStamp ||
        !Number.isFinite(policy.expiresAt)) throw Error("invalid-work-selection");
    return policy;
  };
  const write = policy => queue.writeDurable(policyFile,JSON.stringify(policy));
  function locked(action) {
    fs.mkdirSync(root,{recursive:true,mode:0o700});
    const release = queue.acquireLock(path.join(root,"lock"));
    if (!release) return {status:"busy",delivery:"disabled"};
    try { return action(); } finally { release(); }
  }
  const canonicalPath = source => { try { return fs.realpathSync(source); } catch { return null; } };
  const validIdentity = value => value && ["owner","deviceId","salt"].every(k=>typeof value[k]==="string" && value[k]);
  function active(policy,current) {
    return policy?.version === 1 && policy.enabled && policy.expiresAt > now() && validIdentity(current) &&
      policy.scope.owner === current.owner && policy.scope.deviceId === current.deviceId && policy.scope.policyStamp === current.policyStamp;
  }
  function revoke(policy) {
    if (!policy) return true;
    write({...policy,enabled:false,purgePending:true}); // denial precedes deletion
    const complete = retireDirectory(path.join(chunks,policy.queueId),true,now());
    if (complete) write({...policy,enabled:false,purgePending:false});
    return complete;
  }
  function enable(source,sessionId) {
    return locked(()=>{
      const current=identity();
      if (!validIdentity(current) || current.tokenExpired===true) throw Error("work-auth-unavailable");
      const canonical=fs.realpathSync(source), meta=sourceMetadata(canonical);
      if (meta.originator!=="codex_work_desktop" || meta.source!=="vscode" || meta.parent_thread_id) throw Error("unsupported-work-source");
      if (meta.id!==sessionId) throw Error("scope-mismatch");
      const previous=read();
      if (previous && !revoke(previous)) return {status:"busy",delivery:"disabled"};
      const scope={owner:current.owner,deviceId:current.deviceId,policyStamp:current.policyStamp,cwd:meta.cwd,
        sessionId,originator:meta.originator,surface:"chatgpt_work",consentStamp:crypto.randomUUID()};
      const queueId=queue.hmac(current.salt,canonical);
      const consent=queue.observeConsent(chunks,canonical,scope,current.salt,true,scope.consentStamp,true);
      if (!consent) return {status:"busy",delivery:"disabled"};
      write({version:1,enabled:true,source:canonical,fileId:meta.fileId,queueId,scope,expiresAt:now()+TTL_MS});
      return {status:"enabled-local-only",delivery:"disabled"};
    });
  }
  function capture(input) {
    return locked(()=>{
      const policy=read();
      if (policy?.purgePending) revoke(policy);
      if (!policy?.enabled) return {status:"not-enabled",delivery:"disabled"};
      const current=identity();
      if (!active(policy,current)) { revoke(policy); return {status:"revoked",delivery:"disabled"}; }
      if (input?.session_id!==policy.scope.sessionId || (input.cwd && input.cwd!==policy.scope.cwd) ||
          (input.transcript_path && canonicalPath(input.transcript_path)!==policy.source)) {
        return {status:"scope-mismatch",delivery:"disabled"};
      }
      try {
        const meta=sourceMetadata(policy.source);
        if (meta.id!==policy.scope.sessionId || meta.cwd!==policy.scope.cwd || meta.fileId!==policy.fileId ||
            meta.originator!=="codex_work_desktop" || meta.source!=="vscode" || meta.parent_thread_id) {
          revoke(policy); return {status:"revoked",delivery:"disabled"};
        }
        const dir=path.join(chunks,policy.queueId);
        if (!retireDirectory(dir,false,now())) return {status:"busy",delivery:"disabled"};
        const consent=queue.observeConsent(chunks,policy.source,policy.scope,current.salt,true,policy.scope.consentStamp);
        if (!consent) return {status:"busy",delivery:"disabled"};
        const result=queue.stage(chunks,policy.source,policy.scope,current.salt,{
          consent,preserveSessionMetadata:true,
          authorizeCommit:()=>read()?.scope.consentStamp===policy.scope.consentStamp && active(read(),identity()),
          authorizeRecord:record=>{
            if (record.type==="session_meta") return record.payload?.id===meta.id && record.payload?.originator===meta.originator && record.payload?.cwd===meta.cwd && record.payload?.source==="vscode" && !record.payload?.parent_thread_id;
            return record.type!=="turn_context" || !record.payload?.cwd || record.payload.cwd===meta.cwd;
          },
        });
        const cursorFile = path.join(dir,"cursor.json");
        const offset = result.cursor?.offset ?? (fs.existsSync(cursorFile) ? JSON.parse(fs.readFileSync(cursorFile,"utf8")).offset : 0);
        const pendingBytes = Math.max(0,fs.statSync(policy.source).size-offset);
        return {status:result.status,delivery:"disabled",chunks:result.files.length,partial:pendingBytes>0,pendingBytes};
      } catch(error) {
        if (["consent-source-rewritten","source-scope-changed","source-owner-changed","ENOENT"].includes(error.message) || error.code==="ENOENT") revoke(policy);
        const known=["malformed-complete-record","oversized-single-record","source-scope-changed","consent-source-rewritten","consent-changed-during-stage","invalid-cursor","unsupported-session-originator"];
        return {status:known.includes(error.message)?error.message:"source-unavailable",delivery:"disabled"};
      }
    });
  }
  function status() {
    const policy=read(), current=identity();
    return {enabled:!!active(policy,current),delivery:"disabled",tokenExpired:current?.tokenExpired ?? null,expiresAt:policy?.expiresAt || null,purgePending:!!policy?.purgePending};
  }
  function matches(sessionId) { return read()?.scope.sessionId===sessionId; }
  function disable() { return locked(()=>({status:revoke(read())?"disabled":"purge-pending",delivery:"disabled"})); }
  function reconcile() { const policy=read(); return capture({session_id:policy?.scope.sessionId}); }
  return {enable,capture,reconcile,status,matches,disable};
}
module.exports={createWorkCapture,isWorkSource,sourceMetadata,TTL_MS};

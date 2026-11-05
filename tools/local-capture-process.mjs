import {spawn, execFile} from 'node:child_process';
import path from 'node:path';

const ownedChildren = new WeakSet();
const CLOSE_WAIT_MS = 5000;

function terminateOwnedTree(child, {isRunning}) {
  if (!ownedChildren.has(child) || !isRunning() ||
      !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    return;
  }
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  return new Promise((resolve, reject) => {
    execFile(executable, ['/PID', String(child.pid), '/T', '/F'],
      {windowsHide:true, timeout:5000}, error => {
        if (error) reject(new Error('Owned capture tree termination failed', {cause:error}));
        else resolve();
      });
  });
}

/**
 * Spawn one owned capture child. options.stdio must be an array containing one
 * 'ipc' entry (for example ['ignore', logFd, logFd, 'ipc']). No shell is used.
 * At timeout send {type:'abort', reason:'timeout'}, then allow graceMs (10s by
 * default) for the worker's finally blocks before terminating its owned tree.
 * Resolve {status: exitCode, signal, timedOut}; callers MUST reject timedOut or
 * status !== 0, including a cooperative late exit with status 0.
 * recoverAfterTimeout(result) runs once, only after close and successful forced
 * termination if needed. Spawn, IPC configuration, termination, missing close,
 * and recovery errors reject. An unconfirmed close never permits recovery.
 * spawnImpl and killTree(child, {isRunning}) are trusted test/caller adapters.
 */
export function runBoundedCaptureProcess({file, args = [], options = {}, timeoutMs,
  graceMs = 10000, spawnImpl = spawn, killTree = terminateOwnedTree,
  recoverAfterTimeout} = {}) {
  return new Promise((resolve, reject) => {
    if (typeof file !== 'string' || !file || !Array.isArray(args) ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647 ||
        !Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 2147483647 ||
        typeof spawnImpl !== 'function' || typeof killTree !== 'function' ||
        (recoverAfterTimeout !== undefined && typeof recoverAfterTimeout !== 'function')) {
      reject(new TypeError('Invalid bounded capture process configuration')); return;
    }
    const stdio = options.stdio ?? ['ignore', 'ignore', 'ignore', 'ipc'];
    if (!Array.isArray(stdio) || stdio.filter(value => value === 'ipc').length !== 1) {
      reject(new TypeError('Capture stdio requires exactly one IPC channel')); return;
    }
    // Native spawn timeouts/abort signals would bypass the cooperative grace period.
    const {timeout:ignoredTimeout, signal:ignoredSignal, killSignal:ignoredKillSignal,
      ...spawnOptions} = options;
    let child;
    try {
      child = spawnImpl(file, args, {...spawnOptions, stdio, shell:false,
        windowsHide:true, detached:process.platform !== 'win32'});
    } catch (error) { reject(error); return; }
    ownedChildren.add(child);
    let exited = false, closed = false, settled = false, timedOut = false;
    let deadlineTimer, graceTimer, closeTimer, termination;
    const running = () => !exited && !closed && !settled &&
      child.exitCode == null && child.signalCode == null;
    const cleanup = () => {
      clearTimeout(deadlineTimer); clearTimeout(graceTimer); clearTimeout(closeTimer);
      ownedChildren.delete(child);
    };
    const fail = error => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    };
    const force = () => {
      if (!running()) return;
      termination = Promise.resolve().then(() => {
        if (running()) return killTree(child, {isRunning:running});
      });
      termination.then(() => {
        if (!closed && !settled) {
          clearTimeout(closeTimer);
          closeTimer = setTimeout(() =>
            fail(new Error('Capture tree termination did not produce child close')), CLOSE_WAIT_MS);
        }
      }, fail);
    };
    child.once('error', fail);
    child.once('exit', () => {
      exited = true; clearTimeout(deadlineTimer); clearTimeout(graceTimer);
      if (!closed && !settled) closeTimer = setTimeout(() =>
        fail(new Error('Capture exited without closing its output handles')), CLOSE_WAIT_MS);
    });
    child.once('close', async (status, signal) => {
      closed = true; clearTimeout(deadlineTimer); clearTimeout(graceTimer); clearTimeout(closeTimer);
      if (settled) return;
      try {
        await termination;
        if (settled) return;
        const result = {status, signal:signal ?? null, timedOut};
        if (timedOut && recoverAfterTimeout) await recoverAfterTimeout(result);
        if (settled) return;
        settled = true; cleanup(); resolve(result);
      } catch (error) { fail(error); }
    });
    deadlineTimer = setTimeout(() => {
      if (!running()) return;
      timedOut = true;
      graceTimer = setTimeout(force, graceMs);
      if (child.connected && typeof child.send === 'function') {
        try { child.send({type:'abort', reason:'timeout'}, () => {}); }
        catch { /* A closed IPC channel still gets the bounded grace period. */ }
      }
    }, timeoutMs);
  });
}

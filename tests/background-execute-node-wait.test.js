const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function extractConst(source, name) {
  const pattern = new RegExp(`const\\s+${name}\\s*=\\s*[^;]+;`);
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`missing const ${name}`);
  }
  return match[0];
}

function extractFunction(source, name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
  }
  if (braceStart < 0) {
    throw new Error(`missing body for function ${name}`);
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

test('executeNodeAndWait waits for background-completion node settlement before continuing', async () => {
  const source = fs.readFileSync('background.js', 'utf8');
  const moduleSource = [
    extractConst(source, 'AUTO_RUN_BACKGROUND_COMPLETION_SETTLE_TIMEOUT_MS'),
    extractConst(source, 'AUTO_RUN_BACKGROUND_COMPLETION_SETTLE_POLL_MS'),
    extractFunction(source, 'executeNodeAndWait'),
    'return executeNodeAndWait;',
  ].join('\n');

  const state = {
    nodeStatuses: {
      'fetch-login-code': 'pending',
    },
    autoStepDelaySeconds: 0,
  };

  const executeNodeAndWait = new Function(
    'deps',
    `
    const {
      addLog,
      doesNodeUseBackgroundCompletion,
      doesNodeUseCompletionSignal,
      executeNode,
      getAutoRunPreExecutionDelayMsForNode,
      getNodeCompletionSignalTimeoutMs,
      getState,
      getStepIdByNodeIdForState,
      isStepDoneStatus,
      normalizeAutoStepDelaySeconds,
      sleepWithStop,
      throwIfStopped,
    } = deps;
    ${moduleSource}
  `
  )({
    addLog: async () => {},
    doesNodeUseBackgroundCompletion: () => true,
    doesNodeUseCompletionSignal: () => false,
    executeNode: async (nodeId) => {
      state.nodeStatuses[nodeId] = 'running';
      setTimeout(() => {
        state.nodeStatuses[nodeId] = 'completed';
      }, 80);
    },
    getAutoRunPreExecutionDelayMsForNode: () => 0,
    getNodeCompletionSignalTimeoutMs: () => 1000,
    getState: async () => ({
      ...state,
      nodeStatuses: { ...state.nodeStatuses },
    }),
    getStepIdByNodeIdForState: () => 8,
    isStepDoneStatus: (status) => ['completed', 'manual_completed', 'skipped'].includes(String(status || '').trim()),
    normalizeAutoStepDelaySeconds: () => 0,
    sleepWithStop: (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms)),
    throwIfStopped: () => {},
  });

  const startedAt = Date.now();
  await executeNodeAndWait('fetch-login-code', 0);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(state.nodeStatuses['fetch-login-code'], 'completed');
  assert.ok(elapsedMs >= 70, `expected executeNodeAndWait to wait for settlement, actual ${elapsedMs}ms`);
});

import CDP from 'chrome-remote-interface';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SESSION = process.env.JOT_LIVE_SESSION ?? 'jot';
const TARGET_URL = process.env.JOT_LIVE_TARGET_URL ?? 'https://example.com/';
const EXTENSION_PATH = new URL('../../.output/chrome-mv3', import.meta.url).pathname;
const FAKE_MEDIA_ARGS = '--use-fake-device-for-media-stream,--use-fake-ui-for-media-stream';
const FIXTURE = {
  activeTab: {
    id: Number(process.env.JOT_LIVE_FIXTURE_TAB_ID ?? 101),
    title: process.env.JOT_LIVE_FIXTURE_TITLE ?? 'ChatGPT - Google Chrome',
    url: process.env.JOT_LIVE_FIXTURE_URL ?? 'https://chatgpt.com/chat',
  },
};

async function runAgentBrowser(args) {
  const { stdout } = await execFileAsync('agent-browser', ['--session', SESSION, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function openBrowser() {
  await runAgentBrowser(['close']).catch(() => undefined);
  await runAgentBrowser([
    '--headed',
    '--extension',
    EXTENSION_PATH,
    '--args',
    FAKE_MEDIA_ARGS,
    'open',
    TARGET_URL,
  ]);
  return await runAgentBrowser(['get', 'cdp-url']);
}

function parseConnectionOptions(browserWebSocketUrl) {
  const url = new URL(browserWebSocketUrl);
  return { host: url.hostname, port: Number(url.port) };
}

async function waitForBackgroundTarget(connectionOptions, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const targets = await CDP.List(connectionOptions);
    const target = targets.find(
      (candidate) =>
        candidate.type === 'service_worker' &&
        candidate.url.startsWith('chrome-extension://') &&
        candidate.url.endsWith('/background.js'),
    );
    if (target) return target;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Jot background service-worker CDP target was not found');
}

async function evaluate(client, expression) {
  const result = await client.Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

async function runControlPlaneSmoke(client) {
  const orphanSessionId = `rec_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  return await evaluate(
    client,
    `
(async () => {
  const assert = (condition, message, details) => {
    if (!condition) throw new Error(message + (details ? ': ' + JSON.stringify(details) : ''));
  };
  globalThis.__JOT_TEST_CONTROL_PLANE_ENABLED__ = true;
  assert(globalThis.__JOT_TEST_CONTROL_PLANE__, 'control plane hook missing');

  const send = (message) => globalThis.__JOT_TEST_CONTROL_PLANE__.send(message);
  const fixture = ${JSON.stringify(FIXTURE)};
  const before = await send({ type: 'TEST_GET_SNAPSHOT' });
  if (before?.snapshot?.state === 'recording' || before?.snapshot?.state === 'armed') {
    await send({ type: 'TEST_STOP_RECORDING' }).catch(() => null);
  }

  await send({ type: 'TEST_RESET_TEST_FIXTURES' });
  const baseline = await send({ type: 'TEST_GET_CAPTURE_FIXTURE' });
  assert(baseline?.ok === true, 'baseline fixture read failed', baseline);
  assert(baseline.captureFixture?.activeTab === null, 'baseline active tab not clear', baseline);

  const setFixture = await send({ type: 'TEST_SET_CAPTURE_FIXTURE', captureFixture: fixture });
  assert(setFixture?.ok === true, 'set fixture failed', setFixture);
  assert(setFixture.captureFixture?.activeTab?.id === fixture.activeTab.id, 'fixture id mismatch', setFixture);

  const prepare = await send({ type: 'TEST_PREPARE_START', includeMic: false, quality: 'auto' });
  assert(prepare?.ok === true, 'prepare failed', prepare);
  assert(prepare.snapshot?.state === 'armed', 'prepare did not arm', prepare);

  const started = await send({ type: 'TEST_START_RECORDING', audioSource: 'tab', quality: 'auto' });
  assert(started?.ok === true, 'start failed', started);
  assert(started.snapshot?.state === 'recording', 'start did not record', started);

  const inFlightFilename = await send({ type: 'TEST_GET_LAST_FILENAME' });
  assert(inFlightFilename?.ok === true, 'in-flight filename read failed', inFlightFilename);
  assert(typeof inFlightFilename.outputFileName === 'string', 'in-flight filename missing', inFlightFilename);
  assert(inFlightFilename.outputFileName.includes('ChatGPT'), 'filename did not use fixture metadata', inFlightFilename);

  const persistedDuring = await send({ type: 'TEST_GET_CAPTURE_FIXTURE' });
  assert(persistedDuring.captureFixture?.activeTab?.id === fixture.activeTab.id, 'fixture not available during recording', persistedDuring);

  const stopped = await send({ type: 'TEST_STOP_RECORDING' });
  assert(stopped?.ok === true, 'stop failed', stopped);
  assert(stopped.snapshot?.state === 'done', 'stop did not reach done', stopped);

  const afterStopFilename = await send({ type: 'TEST_GET_LAST_FILENAME' });
  assert(afterStopFilename?.ok === true, 'post-stop filename read failed', afterStopFilename);
  assert(afterStopFilename.outputFileName === inFlightFilename.outputFileName, 'filename changed after stop', {
    inFlightFilename,
    afterStopFilename,
  });

  const persistedFixture = await send({ type: 'TEST_GET_CAPTURE_FIXTURE' });
  assert(persistedFixture.captureFixture?.activeTab?.url === fixture.activeTab.url, 'fixture not persisted', persistedFixture);

  const orphanSession = {
    sessionId: ${JSON.stringify(orphanSessionId)},
    startTime: Date.now() - 120000,
    recordingQuality: 'auto',
    recordingResolvedQuality: '1080p30',
    recordingKind: 'webcodecs-opfs',
    streamBytesWritten: 1,
  };

  const seededOrphans = await send({
    type: 'TEST_SET_ORPHAN_FIXTURE',
    orphanFixture: {
      sessions: [orphanSession],
    },
  });
  assert(seededOrphans?.ok === true, 'seed orphan fixture failed', seededOrphans);
  assert(seededOrphans.orphanFixture?.sessions?.length === 1, 'orphan fixture not stored', seededOrphans);

  const refreshedOrphans = await send({ type: 'TEST_REFRESH_ORPHANS' });
  assert(refreshedOrphans?.ok === true, 'refresh orphans failed', refreshedOrphans);
  assert(Array.isArray(refreshedOrphans.snapshot?.orphanedSessions), 'orphan snapshot missing', refreshedOrphans);
  assert(refreshedOrphans.snapshot?.orphanedSessions?.length === 1, 'orphan scan did not surface session', refreshedOrphans);

  const recoveredOrphan = await send({
    type: 'TEST_RECOVER_ORPHAN',
    sessionId: orphanSession.sessionId,
  });
  assert(recoveredOrphan?.snapshot?.state === 'recovery', 'orphan recover did not enter recovery', recoveredOrphan);
  assert(
    recoveredOrphan.snapshot?.recoverySessionId === orphanSession.sessionId,
    'recovery session mismatch',
    recoveredOrphan,
  );
  assert(
    Array.isArray(recoveredOrphan.snapshot?.recoveryChunks) &&
      recoveredOrphan.snapshot?.recoveryChunks.length === 1 &&
      recoveredOrphan.snapshot?.recoveryChunks[0]?.included === false,
    'recovery chunks did not reflect missing orphan data',
    recoveredOrphan,
  );

  const discardedOrphan = await send({
    type: 'TEST_DISCARD_ORPHAN',
    sessionId: orphanSession.sessionId,
  });
  assert(discardedOrphan?.ok === true, 'discard orphan failed', discardedOrphan);
  assert(
    Array.isArray(discardedOrphan.snapshot?.orphanedSessions) &&
      discardedOrphan.snapshot.orphanedSessions.length === 0,
    'discard did not clear orphan sessions',
    discardedOrphan,
  );

  const orphanFixtureAfterDiscard = await send({ type: 'TEST_GET_ORPHAN_FIXTURE' });
  assert(
    orphanFixtureAfterDiscard?.orphanFixture?.sessions?.length === 0,
    'orphan fixture still populated after discard',
    orphanFixtureAfterDiscard,
  );

  const reset = await send({ type: 'TEST_RESET_TEST_FIXTURES' });
  assert(reset?.ok === true, 'reset failed', reset);
  assert(reset.captureFixture?.activeTab === null, 'reset did not clear fixture', reset);
  assert(reset.orphanFixture?.sessions?.length === 0, 'reset did not clear orphan fixture', reset);

  return {
    ok: true,
    workerUrl: location.href,
    preparedState: prepare.snapshot.state,
    recordingState: started.snapshot.state,
    finalState: stopped.snapshot.state,
    outputFileName: afterStopFilename.outputFileName,
    orphanSessionId: orphanSession.sessionId,
  };
})()
`,
  );
}

const browserWebSocketUrl = await openBrowser();
const connectionOptions = parseConnectionOptions(browserWebSocketUrl);
const target = await waitForBackgroundTarget(connectionOptions);
const client = await CDP({ ...connectionOptions, target });

try {
  await client.Runtime.enable();
  const result = await runControlPlaneSmoke(client);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
}

/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createEsvFileSource } from '../../src/server/content/esv-files.ts';
import { importText } from '../../src/server/content/import.ts';
import { writeEsvFixture } from '../support/esv-fixture.ts';
import { signIn, startHarness } from '../support/harness.ts';

test('ESV is selectable and a downloaded chapter reads after a cold browser restart with no network', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'esv-browser-'));
  const profile = join(dir, 'profile');
  const h = await startHarness({ STATIC_DIR: 'dist/client', OWNER_EMAIL: '' });
  try {
    await writeEsvFixture(dir);
    assert.equal((await importText({ db: h.db, clock: h.clock, text: createEsvFileSource(dir) }, { translationId: 'ESV' })).status, 'succeeded');
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
    const { cookie } = await signIn(h, 'esv-browser@example.test');
    const online = await chromium.launchPersistentContext(profile);
    try {
      await online.addCookies([{ name: 'bs_session', value: cookie, url: baseUrl }]);
      const page = online.pages()[0];
      await page.goto(baseUrl);
      await page.getByLabel('Translation', { exact: true }).selectOption('ESV');
      await page.getByLabel('Book', { exact: true }).selectOption('PHM');
      await page.locator('#v-3').waitFor();
      assert.equal(await page.locator('.verse').count(), 2);
      await page.getByRole('heading', { name: 'Fixture heading' }).waitFor();
      await page.getByText('Alternative reading', { exact: false }).waitFor();
      await page.getByText('Cross-reference: Fixture 2:1', { exact: false }).waitFor();
      await page.getByText('No licensed ESV recording.', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'Download for offline' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByText('Text only').click();
      await dialog.getByRole('button', { name: 'Download', exact: true }).click();
      await page.getByText('Downloaded — readable offline.').waitFor();
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
      // Reader saves the selected translation and place after two seconds.
      await page.waitForFunction(async () => {
        const r = await fetch('/api/sync/pull');
        const p = (await r.json()).soloPosition;
        return p?.translationId === 'ESV' && p.bookId === 'PHM';
      });
      // Refresh once online so the device has also pulled the acknowledged position.
      await page.reload();
      await page.locator('#v-3').waitFor();
    } finally { await online.close(); }

    const offline = await chromium.launchPersistentContext(profile, { offline: true });
    try {
      const page = offline.pages()[0];
      await page.goto(baseUrl);
      await page.getByText('Reading the copy downloaded to this device.').waitFor().catch(async (error: unknown) => {
        throw new Error(await page.locator('body').innerText(), { cause: error });
      });
      assert.equal(await page.getByLabel('Translation', { exact: true }).inputValue(), 'ESV');
      assert.equal(await page.locator('.verse').count(), 2);
      assert.match(await page.locator('#v-1').innerText(), /Second fixture line/);
      assert.equal(await page.locator('#v-2').count(), 0);
    } finally { await offline.close(); }
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});

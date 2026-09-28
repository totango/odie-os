import { test, expect, type Page } from '@playwright/test'

const frame = (page: Page) => page.frameLocator('iframe')
const state = (page: Page) => frame(page).locator('html').evaluate(element => ({
  boot: (element as HTMLElement).dataset.boot,
  draft: element.querySelector('input')!.value,
  scroll: element.ownerDocument.scrollingElement!.scrollTop,
}))
const ledger = (page: Page) => page.evaluate(() => {
  const entries = (window as unknown as {
    __continuityLedger(): { id: number; owner: string; ended: string | null }[]
  }).__continuityLedger()
  return {
    created: entries.length,
    componentCreated: entries.filter(entry => entry.owner === 'component').length,
    componentLive: entries.filter(entry => entry.owner === 'component' && !entry.ended).length,
    fixtureLive: entries.filter(entry => entry.owner === 'fixture' && !entry.ended).length,
    live: entries.filter(entry => !entry.ended).length,
  }
})

async function read(page: Page, expected: string) {
  await frame(page).getByRole('button', { name: 'Read server' }).click()
  await expect(frame(page).locator('#result')).toHaveText(expected)
}

async function prepare(page: Page, url = '/') {
  await page.goto(url)
  await expect(page.locator('#boots')).toHaveText('1')
  await read(page, 'epoch-1')
  await frame(page).getByLabel('Unsaved draft').fill('lifecycle draft')
  await frame(page).locator('html').evaluate(element => element.ownerDocument.defaultView!.scrollTo(0, 640))
  await expect.poll(async () => (await state(page)).scroll).toBe(640)
  return state(page)
}

test('immediate module RPC survives delayed initial acquisition', async ({ page }) => {
  await page.goto('/?initial=delayed&immediate=1')
  await expect(page.locator('#boots')).toHaveText('1')
  await expect(page.locator('#connections')).not.toHaveText('0')
  // The module issues the read itself, before connectToGadget resolves. Never
  // click Read server here: that would conceal a lost initial call.
  await expect(frame(page).locator('#result')).toHaveText('pending')
  await page.getByRole('button', { name: 'Release initial acquisition' }).click()
  await expect(frame(page).locator('#result')).toHaveText('epoch-1')
  await expect(page.locator('#boots')).toHaveText('1')
})

test('hidden-first Activity handshakes after reveal and cancels suspended bootstrap', async ({ page }) => {
  await page.goto('/?initial=delayed&immediate=1&hidden=1')
  await expect(page.getByRole('button', { name: 'Show Activity' })).toBeVisible()
  await expect(page.locator('#boots')).toHaveText('0')
  await page.getByRole('button', { name: 'Show Activity' }).click()
  await expect(page.locator('#boots')).toHaveText('1')
  await expect(frame(page).locator('#result')).toHaveText('pending')
  await page.getByRole('button', { name: 'Hide Activity' }).click()
  await expect(page.locator('iframe')).toBeHidden()
  await page.getByRole('button', { name: 'Release initial acquisition' }).click()
  await page.getByRole('button', { name: 'Show Activity' }).click()
  // Hiding revokes the pending acquisition. It must not replay that call under a
  // new generation; a fresh user call after reveal must work in the same document.
  await expect(frame(page).locator('#result')).toContainText('not dispatched')
  await read(page, 'epoch-1')
  await expect(page.locator('#boots')).toHaveText('1')
})

test('sixty-second real outage preserves document and recovers fresh reads', async ({ page }, testInfo) => {
  test.setTimeout(80_000)
  const before = await prepare(page)
  await page.getByRole('button', { name: 'Begin delayed replacement' }).click()
  await expect(page.locator('#connections')).not.toHaveText('1')
  await frame(page).getByRole('button', { name: 'Read server' }).click()
  await expect(frame(page).locator('#result')).toContainText('not dispatched')
  const started = Date.now()
  // Intentional wall-clock outage, not a fast-forwarded timer simulation.
  await page.waitForTimeout(60_000)
  await expect(page.locator('#boots')).toHaveText('1')
  await expect(frame(page).locator('#result')).toContainText('not dispatched')
  await page.getByRole('button', { name: 'Release replacement' }).click()
  // Reconnect must not replay arbitrary user-defined writes. Retry explicitly.
  await read(page, 'epoch-2')
  const after = await state(page)
  await testInfo.attach('long-outage', {
    body: JSON.stringify({ elapsedMs: Date.now() - started, before, after }), contentType: 'application/json',
  })
  expect(after).toEqual(before)
})

test('100 reconnect and Activity cycles keep one document and bounded real sessions', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  const before = await prepare(page)
  const initialLedger = await ledger(page)
  expect(initialLedger.componentLive).toBeGreaterThan(0)
  for (let cycle = 0; cycle < 100; cycle++) {
    await page.getByRole('button', { name: 'Replace now', exact: true }).click()
    await read(page, `epoch-${cycle + 2}`)
    await page.getByRole('button', { name: 'Hide Activity' }).click()
    await expect(page.locator('iframe')).toBeHidden()
    await page.getByRole('button', { name: 'Show Activity' }).click()
    await read(page, `epoch-${cycle + 2}`)
    await expect.poll(async () => (await ledger(page)).live).toBe(initialLedger.live)
  }
  const finalLedger = await ledger(page)
  const after = await state(page)
  console.log(JSON.stringify({ cycles: 100, initialLedger, finalLedger, before, after }))
  await testInfo.attach('100-cycle-session-ledger', {
    body: JSON.stringify({ cycles: 100, initialLedger, finalLedger, before, after }), contentType: 'application/json',
  })
  expect(after).toEqual(before)
  await expect(page.locator('#boots')).toHaveText('1')
  expect(finalLedger.componentLive).toBe(initialLedger.componentLive)
  expect(finalLedger.fixtureLive).toBe(2)
})

for (const [surface, url] of [['gadget', '/'], ['management', '/management.html']]) {
  test(`${surface} unmount while hidden closes actual host and fixture sessions`, async ({ page }, testInfo) => {
    await prepare(page, url)
    const initialLedger = await ledger(page)
    expect(initialLedger.componentLive).toBeGreaterThan(0)
    await page.getByRole('button', { name: 'Hide Activity' }).click()
    await expect(page.locator('iframe')).toBeHidden()
    const hidden = await ledger(page)
    expect(hidden.componentLive).toBeGreaterThan(0)
    expect(hidden.componentLive).toBeLessThanOrEqual(initialLedger.componentLive)
    await page.getByRole('button', { name: 'Unmount fixture' }).click()
    await expect(page.locator('iframe')).toHaveCount(0)
    await expect.poll(async () => (await ledger(page)).live).toBe(0)
    await testInfo.attach('hidden-unmount-ledger', {
      body: JSON.stringify({ hidden, unmounted: await ledger(page) }), contentType: 'application/json',
    })
  })
}

test('management HTML change waits for explicit acceptance', async ({ page }) => {
  const before = await prepare(page, '/management.html')
  await page.getByRole('button', { name: 'Publish HTML update' }).click()
  const accept = page.getByRole('button', { name: /reload when ready/i })
  await expect(accept).toBeVisible()
  await expect(page.locator('#boots')).toHaveText('1')
  expect(await state(page)).toEqual(before)
  await read(page, 'epoch-1')
  await accept.click()
  await expect(page.locator('#boots')).toHaveText('2')
  await expect(frame(page).locator('html')).toHaveAttribute('data-version', '2')
  await read(page, 'epoch-1')
  expect((await state(page)).boot).not.toBe(before.boot)
  await expect(frame(page).getByLabel('Unsaved draft')).toHaveValue('')
})

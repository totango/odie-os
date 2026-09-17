import { test, expect, type Page, type TestInfo } from '@playwright/test'

const frame = (page: Page) => page.frameLocator('iframe[title="Gadget UI"]')

async function documentState(page: Page) {
  return frame(page).locator('html').evaluate(element => ({
    boot: (element as HTMLElement).dataset.boot,
    draft: element.querySelector('input')!.value,
    scroll: element.ownerDocument.scrollingElement!.scrollTop,
    result: element.querySelector('output')!.textContent,
  }))
}

async function prepare(page: Page) {
  await page.goto('/')
  await expect(page.locator('#boots')).toHaveText('1')
  await frame(page).getByRole('button', { name: 'Read server' }).click()
  await expect(frame(page).locator('#result')).toHaveText('epoch-1')
  await frame(page).getByLabel('Unsaved draft').fill('do not discard this draft')
  await frame(page).locator('html').evaluate(element => element.ownerDocument.defaultView!.scrollTo(0, 640))
  await expect.poll(async () => (await documentState(page)).scroll).toBe(640)
  return documentState(page)
}

async function record(page: Page, testInfo: TestInfo, before: Awaited<ReturnType<typeof documentState>>) {
  const after = await documentState(page)
  const evidence = {
    before, after,
    boots: await page.locator('#boots').textContent(),
    connections: await page.locator('#connections').textContent(),
  }
  console.log(JSON.stringify(evidence))
  await testInfo.attach('continuity-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
  expect.soft(after.boot, 'same iframe document, not merely same HTML').toBe(before.boot)
  expect.soft(after.draft, 'unsaved draft survives').toBe(before.draft)
  expect.soft(after.scroll, 'document scroll survives').toBe(before.scroll)
  expect.soft(evidence.boots, 'iframe executes exactly once').toBe('1')
}

test('fast replacement preserves the real iframe and redirects RPC', async ({ page }, testInfo) => {
  const before = await prepare(page)
  await page.getByRole('button', { name: 'Replace now', exact: true }).click()
  await expect(page.locator('#connections')).toHaveText('2')
  await frame(page).getByRole('button', { name: 'Read server' }).click()
  await expect(frame(page).locator('#result')).toHaveText('epoch-2')
  await record(page, testInfo, before)
})

test('replacement taking longer than five seconds preserves draft, scroll and document', async ({ page }, testInfo) => {
  const before = await prepare(page)
  await page.getByRole('button', { name: 'Begin delayed replacement' }).click()
  await expect(page.locator('#connections')).toHaveText('2')
  // Deliberately real wall-clock time: must cross the existing 5s recovery timeout.
  // The transport remains gated; no browser offline setting or fake timer involved.
  await page.waitForTimeout(6_200)
  await page.getByRole('button', { name: 'Release replacement' }).click()
  await frame(page).getByRole('button', { name: 'Read server' }).click()
  await expect(frame(page).locator('#result')).toHaveText('epoch-2')
  await record(page, testInfo, before)
})

test('Activity hide/show keeps the document AND a usable bridge', async ({ page }, testInfo) => {
  const before = await prepare(page)
  await page.getByRole('button', { name: 'Hide Activity' }).click()
  await expect(page.locator('#visibility')).toHaveText('hidden')
  await expect(page.locator('iframe')).toBeHidden()
  await page.getByRole('button', { name: 'Show Activity' }).click()
  await expect(page.locator('iframe')).toBeVisible()
  await frame(page).getByRole('button', { name: 'Read server' }).click()
  await record(page, testInfo, before)
  // Keeping DOM alone is insufficient: Activity tears down and recreates effects.
  await expect(frame(page).locator('#result')).toHaveText('epoch-1')
})

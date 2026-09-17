import assert from 'node:assert/strict'

// Run against continuity.fixture.html served by Vite. PLAYWRIGHT_MODULE may identify
// the coordinator's installed browser harness without changing frontend dependencies.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(process.env.CONTINUITY_URL ?? 'http://127.0.0.1:5199/src/features/workspace/continuity.fixture.html')
  const frame = page.frameLocator('iframe')
  const state = () => frame.locator('html').evaluate(element => ({
    boot: element.dataset.boot,
    draft: element.querySelector('input').value,
    scroll: element.ownerDocument.scrollingElement.scrollTop,
  }))
  const read = async epoch => {
    await frame.getByRole('button', { name: 'Read', exact: true }).click()
    await frame.locator('#result').filter({ hasText: `epoch-${epoch}` }).waitFor()
  }
  await frame.getByLabel('Draft').fill('preserve this')
  await read(1)
  await frame.locator('html').evaluate(element => element.ownerDocument.defaultView.scrollTo(0, 640))
  const before = await state()
  assert.equal(before.scroll, 640)
  await page.getByRole('button', { name: 'Hide Activity' }).click()
  await page.locator('iframe').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Show Activity' }).click()
  await page.locator('iframe').waitFor({ state: 'visible' })
  await read(1)
  assert.deepEqual(await state(), before)
  await page.getByRole('button', { name: 'Replace authority' }).click()
  await read(2)
  const after = await state()
  assert.deepEqual(after, before)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ browser: await browser.version(), before, after,
    rpc: 'epoch-1 after Activity; epoch-2 after replacement' }))
} finally {
  await browser.close()
}

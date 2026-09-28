import { test, expect, type Page } from '@playwright/test'

const frame = (page: Page) => page.frameLocator('iframe[title="Gatekeeper app"]')
const state = (page: Page) => frame(page).locator('html').evaluate(element => ({
  boot: (element as HTMLElement).dataset.boot,
  draft: element.querySelector('input')!.value,
  scroll: element.ownerDocument.scrollingElement!.scrollTop,
  result: element.querySelector('output')!.textContent,
}))

for (const scenario of ['replacement', 'Activity'] as const) {
  test(`management ${scenario} preserves document state and a usable bridge`, async ({ page }, testInfo) => {
    await page.goto('/management.html')
    await expect(page.locator('#boots')).toHaveText('1')
    await frame(page).getByRole('button', { name: 'Read server' }).click()
    await expect(frame(page).locator('#result')).toHaveText('epoch-1')
    await frame(page).getByLabel('Unsaved draft').fill('unsaved management draft')
    await frame(page).locator('html').evaluate(element => element.ownerDocument.defaultView!.scrollTo(0, 640))
    await expect.poll(async () => (await state(page)).scroll).toBe(640)
    const before = await state(page)

    if (scenario === 'replacement') {
      await page.getByRole('button', { name: 'Replace capability' }).click()
    } else {
      await page.getByRole('button', { name: 'Hide Activity' }).click()
      await expect(page.locator('iframe')).toBeHidden()
      await page.getByRole('button', { name: 'Show Activity' }).click()
      await expect(page.locator('iframe')).toBeVisible()
    }
    await frame(page).getByRole('button', { name: 'Read server' }).click()
    const expected = scenario === 'replacement' ? 'epoch-2' : 'epoch-1'
    await expect.soft(frame(page).locator('#result')).toHaveText(expected)
    const after = await state(page)
    const boots = await page.locator('#boots').textContent()
    const evidence = { scenario, before, after, boots }
    console.log(JSON.stringify(evidence))
    await testInfo.attach('management-continuity-evidence', {
      body: JSON.stringify(evidence, null, 2), contentType: 'application/json',
    })
    expect.soft(after.boot, 'same management document').toBe(before.boot)
    expect.soft(after.draft, 'unsaved management draft').toBe(before.draft)
    expect.soft(after.scroll, 'management scroll').toBe(before.scroll)
    expect.soft(boots, 'management iframe executes exactly once').toBe('1')
  })
}

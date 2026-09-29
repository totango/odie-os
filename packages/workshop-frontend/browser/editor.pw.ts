import { test, expect } from '@playwright/test'

test('real CodeMirror is lazy then retains selection, physical scroll and undo across code-tab hiding', async ({ page }) => {
  await page.goto('/editor.html')
  await expect(page.getByRole('button', { name: 'Open code' })).toBeVisible()
  await expect(page.locator('.cm-editor')).toHaveCount(0)
  await page.getByRole('button', { name: 'Open code' }).click()
  const editor = page.locator('.cm-content[contenteditable="true"]')
  await expect(editor).toBeVisible()
  await editor.click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.type('local ')
  await expect.poll(() => page.evaluate(() => window.editorFixture.snapshot().text.startsWith('local '))).toBe(true)
  await page.evaluate(() => window.editorFixture.select())
  await expect.poll(() => page.evaluate(() => window.editorFixture.snapshot().scroll)).toBe(500)
  const before = await page.evaluate(() => window.editorFixture.snapshot())
  const identity = await page.locator('.cm-editor:has(.cm-content[contenteditable="true"])').elementHandle()
  await page.getByRole('button', { name: 'Hide code' }).click()
  await expect(editor).toBeHidden()
  await page.getByRole('button', { name: 'Remote append' }).click()
  await expect.poll(() => page.evaluate(() => window.editorFixture.snapshot().text.endsWith('\nremote'))).toBe(true)
  await page.getByRole('button', { name: 'Open code' }).click()
  await expect(editor).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.editorFixture.snapshot().scroll)).toBe(before.scroll)
  expect(await identity!.evaluate(element => element === document.querySelector('.cm-content[contenteditable="true"]')!.closest('.cm-editor'))).toBe(true)
  const after = await page.evaluate(() => window.editorFixture.snapshot())
  expect(after).toEqual({ ...before, text: `${before.text}\nremote` })
  await editor.focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => page.evaluate(() => window.editorFixture.snapshot().text.startsWith('local '))).toBe(false)
  expect(await page.evaluate(() => window.editorFixture.snapshot().text.endsWith('\nremote'))).toBe(true)
})

test('recreated split panes retain modified scroll and resume bidirectional scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/editor.html')
  await page.getByRole('button', { name: 'Open code' }).click()
  const scrollers = page.locator('.cm-scroller')
  await expect(scrollers).toHaveCount(2)
  await page.evaluate(() => window.editorFixture.select())

  for (let cycle = 0; cycle < 3; cycle++) {
    await page.getByRole('button', { name: 'Hide code' }).click()
    await page.getByRole('button', { name: 'Open code' }).click()
    await expect(scrollers).toHaveCount(2)
    // A poll can pass before the new pane's first measurement corrupts the retained scroll.
    // Sample across frames to cover measurement, scroll anchoring, and queued scroll events.
    const samples = await page.evaluate(async () => {
      const positions: number[][] = []
      for (let frame = 0; frame < 6; frame++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        positions.push(Array.from(document.querySelectorAll('.cm-scroller'), el => el.scrollTop))
      }
      return positions
    })
    expect(samples.map(positions => positions[1])).toEqual(Array(6).fill(500))
    expect(samples.at(-1)).toEqual([500, 500])

    await scrollers.first().evaluate(el => { el.scrollTop = 800 })
    await expect.poll(() => scrollers.evaluateAll(els => els.map(el => el.scrollTop))).toEqual([800, 800])
    await scrollers.last().evaluate(el => { el.scrollTop = 500 })
    await expect.poll(() => scrollers.evaluateAll(els => els.map(el => el.scrollTop))).toEqual([500, 500])
  }
})

test('Activity reconciles missed B reset without a phantom preview; A row remains authoritative', async ({ page }) => {
  await page.goto('/editor.html')
  await page.getByRole('button', { name: 'Open code' }).click()
  await expect(page.locator('.cm-content[contenteditable="true"]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.editorFixture.snapshot().text.startsWith('line 0'))).toBe(true)
  await page.getByRole('button', { name: 'Preview A' }).click()
  await page.getByRole('button', { name: 'Preview B' }).click()
  await expect.poll(() => page.evaluate(() => window.editorFixture.snapshot().text)).toBe('B has no row')
  await page.getByRole('button', { name: 'Hide Activity' }).click()
  await page.getByRole('button', { name: 'Reset previews' }).click()
  await page.getByRole('button', { name: 'Show Activity' }).click()
  await expect.poll(() => page.evaluate(() => window.editorFixture.snapshot().text.startsWith('line 0'))).toBe(true)
  await page.getByRole('button', { name: 'Commit A' }).click()
  await expect.poll(() => page.evaluate(() => window.editorFixture.snapshot().text)).toBe('A preview')
  await page.getByRole('button', { name: 'Hide Activity' }).click()
  await page.getByRole('button', { name: 'Show Activity' }).click()
  await expect.poll(() => page.evaluate(() => window.editorFixture.snapshot().text)).toBe('A preview')
})

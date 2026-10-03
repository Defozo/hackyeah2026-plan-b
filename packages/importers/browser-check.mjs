import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = process.env.PLANB_TEST_URL ?? 'http://localhost:5181';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const messages = [];
page.on('console', m => { if (m.type() === 'error') messages.push(m.text()); });
page.on('pageerror', e => messages.push(e.message));
const moduleURL = `/@fs/${resolve('packages/importers/src/index.ts').replaceAll('\\', '/')}`;
const checks = [];
try {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 90000 });
  for (const name of ['synthetic-text.pdf', 'synthetic-document.png', 'synthetic-scan.pdf']) {
    const bytes = [...await readFile(`fixtures/imports/${name}`)];
    const started = Date.now();
    const result = await page.evaluate(async ({ moduleURL, name, bytes }) => {
      const { startImport } = await import(moduleURL);
      const task = startImport({ name, data: new Uint8Array(bytes) });
      const result = await task.promise;
      return { status: result.status, complete: result.complete, pages: result.pages.map(p => ({ page: p.page, text: p.text, extraction: p.extraction, confidence: p.confidence, imageBytes: p.image?.length })), facts: result.facts.map(f => ({ text: f.text, value: f.value, status: f.status })), attachments: result.attachments.length, issues: result.issues };
    }, { moduleURL, name, bytes });
    if (!result.complete || result.attachments !== 1 || !result.pages[0]?.text.includes('20')) throw new Error(`${name} did not produce expected evidence: ${JSON.stringify(result)}`);
    if (!result.facts.every(f => f.status === 'pending')) throw new Error('Document facts must remain pending');
    checks.push({ name, milliseconds: Date.now() - started, ...result });
  }
  const cancellation = await page.evaluate(async ({ moduleURL }) => { const { startImport } = await import(moduleURL); const task = startImport({ name: 'abort.csv', data: 'metric,start,value,unit\nsteps,2026-10-03T00:00:00Z,10,steps' }); task.cancel(); try { await task.promise; return false; } catch (error) { return error.name === 'AbortError'; } }, { moduleURL });
  if (!cancellation) throw new Error('Worker cancellation failed');
  checks.push({ cancellation });
  await writeFile('fixtures/imports/browser-verification.json', JSON.stringify({ checkedAt: new Date().toISOString(), browser: await browser.version(), checks, consoleErrors: messages }, null, 2));
  console.log(JSON.stringify({ passed: checks.map(c => c.name ?? 'cancellation'), milliseconds: checks.map(c => c.milliseconds), consoleErrors: messages }, null, 2));
} finally { await browser.close(); }

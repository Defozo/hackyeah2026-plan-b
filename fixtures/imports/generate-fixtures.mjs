import { chromium } from '@playwright/test';
import { Encoder, Profile } from '@garmin/fitsdk';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1 });
await page.setContent('<!doctype html><html lang="pl"><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;font-size:28px;line-height:1.8;padding:50px;color:#182c28}h1{font-size:32px}p{margin:12px 0}</style><h1>Dane syntetyczne. Dokument testowy</h1><p>Data: 2026-10-03</p><p>Czas spaceru: 20 min</p><p>Sen: 7,5 h</p><p>Wartość testowa: 12,5 mg/L</p><p>Brak zakresu referencyjnego w źródle.</p></html>');
await page.screenshot({ path: join(import.meta.dirname, 'synthetic-document.png') });
await page.pdf({ path: join(import.meta.dirname, 'synthetic-text.pdf'), format: 'A4', printBackground: true });
const png = await page.screenshot();
await page.setContent(`<html><style>@page{margin:0}body{margin:0}img{width:100%}</style><img src="data:image/png;base64,${png.toString('base64')}" alt="Dane syntetyczne"></html>`);
await page.pdf({ path: join(import.meta.dirname, 'synthetic-scan.pdf'), format: 'A4', printBackground: true });
await browser.close();
const encoder = new Encoder();
encoder.onMesg(Profile.MesgNum.FILE_ID, { type: 'activity', manufacturer: 'development', product: 1, timeCreated: new Date('2026-10-03T10:00:00Z') });
encoder.onMesg(Profile.MesgNum.SESSION, { startTime: new Date('2026-10-03T10:00:00Z'), timestamp: new Date('2026-10-03T10:20:00Z'), totalElapsedTime: 1200, totalTimerTime: 1200, sport: 'walking' });
await writeFile(join(import.meta.dirname, 'synthetic-activity.fit'), encoder.close());
console.log('Generated local synthetic PDF/image/FIT fixtures.');
